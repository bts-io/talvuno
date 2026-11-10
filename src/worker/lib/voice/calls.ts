/**
 * Call rows and how Twilio's call events move them.
 *
 * Canonical SID: one `calls` row per call, keyed by the PARENT CallSid, the leg Twilio creates first and the
 * only SID known when our TwiML runs. For an outbound call that is the browser (client) leg; for an inbound
 * call it is the caller's PSTN leg. The leg we dial with <Dial> (the PSTN number for outbound, the browser
 * for inbound) is the child. Its status callbacks carry ParentCallSid and are applied to the parent's row,
 * so history shows one row per call with the result of the dialed leg (busy, no-answer, talk time).
 *
 * Which events move a row:
 * - the <Dial action> result (DialCallStatus): the dial's outcome, it closes the row.
 * - child leg callbacks: outbound, applied as they are. Inbound, Twilio rings every device registered with
 *   the owner's identity and each ring can be its own child leg, so only an answer (in-progress, completed)
 *   moves the row; a child that ends unanswered says nothing about the call.
 * - parent leg callbacks: only a terminal one, and only for inbound calls (the number's "call status
 *   changes" URL). It closes a row the child never closed, for example when the caller hangs up while it
 *   rings. Unanswered becomes "no-answer" (missed); answered becomes "completed". Outbound parent leg
 *   callbacks are recorded and ignored, because the browser leg's status says nothing about the PSTN result.
 * Every status goes through nextCallStatus, so replays and out-of-order callbacks never move a row back.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { LivePush } from "../../../contracts";
import type { Db } from "../../db";
import { schema } from "../../db";
import { findContactByNumber } from "../contacts";
import { notifyOwner } from "../hub";
import { onMissedCall } from "../missed-call";
import {
  type CallEvent,
  type CallRow,
  isMissed,
  isWithheld,
  missedCallPush,
  outcomeOnEnd,
  planCallUpdate,
} from "./call-rules";

export * from "./call-rules";
export async function findCall(db: Db, sid: string): Promise<CallRow | null> {
  return (await db.select().from(schema.calls).where(eq(schema.calls.twilioCallSid, sid)).get()) ?? null;
}

/**
 * Applies `event` to the row with this SID and tells the owner's tabs. Missed inbound calls carry a push so
 * a closed app still learns about them. Pass `opts.ctx` so the push goes out after the response. Returns the updated row, or null when nothing changed.
 */
export async function applyCallEvent(
  env: Env,
  db: Db,
  sid: string,
  event: CallEvent,
  opts: { push?: boolean; ctx?: Pick<ExecutionContext, "waitUntil"> } = {},
  attempt = 0,
): Promise<CallRow | null> {
  const row = await findCall(db, sid);
  if (!row) return null;
  const patch = planCallUpdate(row, event);
  if (!patch) return null;
  const outcome = outcomeOnEnd(row, patch);
  if (outcome) patch.outcome = outcome;
  if (!row.contactId) {
    const contact = !isWithheld(row.party) ? await findContactByNumber(db, row.ownerId, row.party) : null;
    if (contact) patch.contactId = contact.id;
  }
  // Guarded on the stored status, so two callbacks racing on the same row cannot both write.
  const updated = await db
    .update(schema.calls)
    .set(patch)
    .where(and(eq(schema.calls.id, row.id), eq(schema.calls.status, row.status)))
    .returning()
    .get();
  // Another callback moved the row first: plan again from what it stored. Statuses only move forward, so
  // this ends quickly; the bound is a guard.
  if (!updated) return attempt < 3 ? applyCallEvent(env, db, sid, event, opts, attempt + 1) : null;

  const missedNow = isMissed(updated) && !isMissed(row);
  let push: LivePush | undefined;
  if (missedNow && opts.push !== false)
    push = missedCallPush(updated, updated.contactId ? await contactName(db, updated.contactId) : null);
  if (missedNow) await onMissedCall(env, updated.ownerId, updated, opts.ctx);
  await notifyOwner(
    env,
    updated.ownerId,
    {
      type: "call",
      callId: updated.id,
      status: updated.status,
      callSid: updated.twilioCallSid,
      errorCode: updated.errorCode ?? undefined,
      errorMessage: updated.errorMessage ?? undefined,
      push,
    },
    opts.ctx,
  );
  return updated;
}

async function contactName(db: Db, contactId: string) {
  const row = await db
    .select({ displayName: schema.contacts.displayName })
    .from(schema.contacts)
    .where(eq(schema.contacts.id, contactId))
    .get();
  return row?.displayName ?? null;
}

// webhook_events: record before processing, skip what was already processed.

async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const payloadString = (params: Record<string, unknown>) =>
  Object.keys(params)
    .sort()
    .map((k) => `${k}=${String(params[k])}`)
    .join("&");

/**
 * Records a webhook under `key`. Returns false when the same key was already processed (a Twilio retry), so
 * the caller answers 200 and does nothing. A key seen but never processed (the first attempt failed) is
 * processed again.
 */
export async function claimWebhook(
  db: Db,
  key: string,
  type: string,
  params: Record<string, unknown>,
): Promise<boolean> {
  const payloadHash = await sha256Hex(payloadString(params));
  const inserted = await db
    .insert(schema.webhookEvents)
    .values({ idempotencyKey: key, type, payloadHash })
    .onConflictDoNothing()
    .returning({ id: schema.webhookEvents.id })
    .get();
  if (inserted) return true;
  const retried = await db
    .update(schema.webhookEvents)
    .set({ attempts: sql`${schema.webhookEvents.attempts} + 1` })
    .where(and(eq(schema.webhookEvents.idempotencyKey, key), isNull(schema.webhookEvents.processedAt)))
    .returning({ id: schema.webhookEvents.id })
    .get();
  return Boolean(retried);
}

export async function finishWebhook(db: Db, key: string, error?: unknown) {
  await db
    .update(schema.webhookEvents)
    .set(
      error === undefined
        ? { processedAt: new Date(), lastError: null }
        : { lastError: String(error).slice(0, 500) },
    )
    .where(eq(schema.webhookEvents.idempotencyKey, key));
}

/** Runs `work` once per webhook key. Errors are recorded and rethrown, so Twilio retries the delivery. */
export async function onceWebhook(
  db: Db,
  key: string,
  type: string,
  params: Record<string, unknown>,
  work: () => Promise<void>,
): Promise<void> {
  if (!(await claimWebhook(db, key, type, params))) return;
  try {
    await work();
  } catch (err) {
    await finishWebhook(db, key, err);
    throw err;
  }
  await finishWebhook(db, key);
}
