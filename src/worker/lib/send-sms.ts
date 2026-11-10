/**
 * Sends one outbound SMS: the guards, the stored message, the Twilio call and the live event. Used by the
 * owner's /api/messages/send and by automatic texts (the missed-call text), so both go through the same
 * checks (`assertCanContact`) and the same idempotency on `clientId`.
 */
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { nextMessageStatus } from "../../contracts/status";
import type { Db } from "../db";
import { messages, type phoneNumbers } from "../db/schema";
import type { AppEnv } from "../types";
import { ApiError } from "./errors";
import {
  applyPendingStatuses,
  notify,
  type TwilioMessage,
  touchConversation,
  upsertConversation,
} from "./sms";
import { assertCanContact } from "./twilio/guards";
import { TwilioApiError, TwilioNotConfiguredError, twilioRest } from "./twilio/rest";

type NumberRow = typeof phoneNumbers.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

function parseStatus(value: string) {
  const s = value?.toLowerCase();
  return s === "accepted" || s === "queued" || s === "sending" || s === "sent" || s === "failed" ? s : null;
}

/**
 * Stores and sends one SMS from `number` to `to` (a full E.164 number). Throws ApiError when a guard refuses
 * it. A Twilio failure does not throw: the stored message is marked failed and returned.
 */
export async function deliverSms(
  deps: { env: Env; db: Db; ctx?: Pick<ExecutionContext, "waitUntil"> },
  ownerId: string,
  number: Pick<NumberRow, "id" | "e164">,
  to: string,
  body: string,
  clientId: string,
): Promise<{ row: MessageRow; conversationId: string; created: boolean }> {
  const { env, db, ctx } = deps;
  await assertCanContact(
    { env, get: ((key: string) => (key === "db" ? db : undefined)) as Context<AppEnv>["get"] },
    ownerId,
    to,
    "sms",
  );

  const conversation = await upsertConversation(db, ownerId, number.id, to);
  const createdAt = new Date();
  const inserted = await db
    .insert(messages)
    .values({
      ownerId,
      conversationId: conversation.id,
      direction: "outbound",
      from: number.e164,
      to,
      body,
      status: "queued",
      clientId,
      createdAt,
    })
    .onConflictDoNothing()
    .returning()
    .get();
  if (!inserted) {
    // Lost a race with the same clientId: the other request sends it.
    const row = await db
      .select()
      .from(messages)
      .where(and(eq(messages.ownerId, ownerId), eq(messages.clientId, clientId)))
      .get();
    if (!row) throw new ApiError(409, "conflict", "Try again");
    return { row, conversationId: row.conversationId, created: false };
  }
  await touchConversation(db, conversation.id, { createdAt, body, direction: "outbound" });

  let row = inserted;
  let sent: TwilioMessage | null = null;
  try {
    sent = await twilioRest(env).post<TwilioMessage>("/Messages.json", {
      From: number.e164,
      To: to,
      Body: body,
      StatusCallback: `${env.PUBLIC_URL.replace(/\/+$/, "")}/api/twilio/sms/status`,
    });
  } catch (err) {
    const failure =
      err instanceof TwilioApiError
        ? { errorCode: err.code, errorMessage: err.message.slice(0, 500) }
        : err instanceof TwilioNotConfiguredError
          ? { errorCode: null, errorMessage: "Twilio is not configured on this deployment" }
          : { errorCode: null, errorMessage: "Could not reach Twilio" };
    if (!(err instanceof TwilioApiError))
      console.error("sms send failed", { messageId: row.id, error: String(err) });
    row =
      (await db
        .update(messages)
        .set({ status: "failed", ...failure })
        .where(eq(messages.id, row.id))
        .returning()
        .get()) ?? row;
  }

  if (sent) {
    // Twilio accepted the message: a D1 failure here must not mark it failed.
    try {
      const status = nextMessageStatus("queued", parseStatus(sent.status) ?? "queued");
      row =
        (await db
          .update(messages)
          .set({ twilioSid: sent.sid, status: nextMessageStatus(row.status, status) })
          .where(eq(messages.id, row.id))
          .returning()
          .get()) ?? row;
      // A status callback may have arrived before we knew the SID.
      row = (await applyPendingStatuses(db, sent.sid)) ?? row;
    } catch (err) {
      console.error("sms accepted by twilio but local update failed", {
        messageId: row.id,
        sid: sent.sid,
        error: String(err),
      });
    }
  }

  await notify(env, ownerId, { type: "message", conversationId: conversation.id, messageId: row.id }, ctx);
  return { row, conversationId: conversation.id, created: true };
}
