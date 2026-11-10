/**
 * Scheduled texts. `sendDueScheduled` is the cron job: it claims every due row with one conditional update
 * (`scheduled` to `sending`), so two overlapping runs never take the same row, then sends each through
 * `deliverSms` (the same guards and hourly limits as a text sent by hand) under the stable client id
 * `sched-<id>`. The cron trigger runs every 15 minutes, so a text goes out within 15 minutes of its time.
 */
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { ScheduledMessage } from "../../contracts/scheduled";
import { createDb, type Db } from "../db";
import { conversations, messages, phoneNumbers, scheduledMessages } from "../db/schema";
import { ApiError } from "./errors";
import { deliverSms } from "./send-sms";
import { notify } from "./sms";

type Row = typeof scheduledMessages.$inferSelect;

/** Rows taken per run, so one run stays well inside a Worker's limits. The rest go out on the next run. */
export const SCHEDULED_BATCH = 25;
/** A row left in `sending` this long was claimed by a run that died. The stable client id makes retrying safe. */
export const SENDING_STALE_MS = 30 * 60 * 1000;

export const scheduledClientId = (id: string) => `sched-${id}`;

export const toScheduledMessage = (r: Row, numberE164: string): ScheduledMessage => ({
  id: r.id,
  numberId: r.numberId,
  numberE164,
  to: r.to,
  body: r.body,
  sendAt: r.sendAt.getTime(),
  status: r.status,
  messageId: r.messageId,
  error: r.error,
  createdAt: r.createdAt.getTime(),
});

/** Atomically takes the due rows. Only one caller can win a given row. */
export async function claimDue(db: Db, now: number): Promise<Row[]> {
  const due = or(
    and(eq(scheduledMessages.status, "scheduled"), lte(scheduledMessages.sendAt, new Date(now))),
    and(
      eq(scheduledMessages.status, "sending"),
      lte(scheduledMessages.updatedAt, new Date(now - SENDING_STALE_MS)),
    ),
  );
  return db
    .update(scheduledMessages)
    .set({ status: "sending", updatedAt: new Date(now) })
    .where(
      and(
        due,
        inArray(
          scheduledMessages.id,
          sql`(SELECT ${scheduledMessages.id} FROM ${scheduledMessages} WHERE ${due} ORDER BY ${scheduledMessages.sendAt} LIMIT ${SCHEDULED_BATCH})`,
        ),
      ),
    )
    .returning()
    .all();
}

const failureText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Could not send this text. Try scheduling it again.";

/** Tells the owner's open tabs the thread changed, when a thread for this text already exists. */
async function announce(env: Env, db: Db, row: Row, numberId: string) {
  const thread = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.ownerId, row.ownerId),
        eq(conversations.numberId, numberId),
        eq(conversations.participant, row.to),
      ),
    )
    .get();
  if (thread) await notify(env, row.ownerId, { type: "conversation", conversationId: thread.id });
}

async function sendOne(env: Env, ctx: ExecutionContext | undefined, db: Db, row: Row) {
  const number = await db
    .select({ id: phoneNumbers.id, e164: phoneNumbers.e164 })
    .from(phoneNumbers)
    .where(
      and(
        eq(phoneNumbers.id, row.numberId),
        eq(phoneNumbers.ownerId, row.ownerId),
        isNull(phoneNumbers.releasedAt),
      ),
    )
    .get();
  let outcome: Partial<Row>;
  if (!number) {
    outcome = { status: "failed", error: "That number is no longer one of yours" };
  } else {
    // A run that died after the send leaves the message behind. Adopt it instead of sending again.
    const existing = await db
      .select({ id: messages.id, status: messages.status, errorMessage: messages.errorMessage })
      .from(messages)
      .where(and(eq(messages.ownerId, row.ownerId), eq(messages.clientId, scheduledClientId(row.id))))
      .get();
    if (existing) {
      outcome =
        existing.status === "failed"
          ? {
              status: "failed",
              error: existing.errorMessage ?? "The text could not be sent",
              messageId: existing.id,
            }
          : { status: "sent", error: null, messageId: existing.id };
    } else {
      try {
        const sent = await deliverSms(
          { env, db, ctx },
          row.ownerId,
          number,
          row.to,
          row.body,
          scheduledClientId(row.id),
        );
        outcome =
          sent.row.status === "failed"
            ? {
                status: "failed",
                error: sent.row.errorMessage ?? "The text could not be sent",
                messageId: sent.row.id,
              }
            : { status: "sent", error: null, messageId: sent.row.id };
      } catch (err) {
        if (!(err instanceof ApiError))
          console.error("scheduled text failed", { id: row.id, error: String(err) });
        outcome = { status: "failed", error: failureText(err) };
      }
    }
  }
  // Only the run that holds the claim writes the outcome.
  await db
    .update(scheduledMessages)
    .set(outcome)
    .where(and(eq(scheduledMessages.id, row.id), eq(scheduledMessages.status, "sending")));
  await announce(env, db, row, row.numberId);
}

/** Cron job: sends every scheduled text whose time has come. */
export async function sendDueScheduled(env: Env, ctx?: ExecutionContext, now = Date.now()): Promise<void> {
  const db = createDb(env.DB);
  const claimed = await claimDue(db, now);
  for (const row of claimed) {
    try {
      await sendOne(env, ctx, db, row);
    } catch (err) {
      // Leave the row in `sending`: the stale rule retries it, and the client id stops a double send.
      console.error("scheduled text could not be finished", { id: row.id, error: String(err) });
    }
  }
}
