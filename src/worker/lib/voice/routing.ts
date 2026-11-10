/**
 * Inbound call routing: where a call to one of the owner's numbers goes.
 *
 *   blocked caller                     <Reject reason="rejected"/>, outcome blocked, no ring, no push
 *   outside business hours, or DND     voicemail TwiML at once, outcome voicemail, no ring, no push
 *   otherwise                          <Enqueue> in a queue of its own, with ringback, plus a live event and
 *                                      a high-priority push. A device answers with <Dial><Queue>.
 *
 * Every device answers through the queue, open or closed, so one path decides who wins: the first claim of the
 * call row (answer_call_sid) gets the queue name, any later claim is refused. The queue name is random per
 * call and never leaves the Worker, so a device can only reach a caller through a claim the server checked
 * against the owner. See docs/decisions.md for why the open app no longer rings through <Client>.
 */
import { and, desc, eq, gt, isNotNull, isNull, or } from "drizzle-orm";
import { RING_SECONDS_DEFAULT } from "../../../contracts/routing";
import type { BusinessHours } from "../../../lib/business-hours";
import en from "../../../shared/locales/en.json";
import type { Db } from "../../db";
import { schema } from "../../db";
import type { CallRow } from "./call-rules";
import type { waitDecision } from "./routing-rules";
import { el, response, text } from "./twiml";

export * from "./routing-rules";

export const DEFAULT_GREETING = en.routing.defaultGreeting;
/** A waiting call older than this is never offered to a device, whatever its row says. */
export const WAITING_MAX_MS = 3 * 60 * 1000;

export type Routing = { ringSeconds: number; voicemailGreeting: string | null; hours: BusinessHours | null };

/** The ring time, greeting and hours of a number, or the defaults when none were saved. */
export async function numberRouting(db: Db, ownerId: string, numberId: string | null): Promise<Routing> {
  const row = numberId
    ? await db
        .select()
        .from(schema.numberRouting)
        .where(and(eq(schema.numberRouting.ownerId, ownerId), eq(schema.numberRouting.numberId, numberId)))
        .get()
    : undefined;
  return {
    ringSeconds: row?.ringSeconds ?? RING_SECONDS_DEFAULT,
    voicemailGreeting: row?.voicemailGreeting ?? null,
    hours: row?.hours ?? null,
  };
}

export async function isDndOn(db: Db, ownerId: string): Promise<boolean> {
  const row = await db
    .select({ dnd: schema.routingSettings.dnd })
    .from(schema.routingSettings)
    .where(eq(schema.routingSettings.ownerId, ownerId))
    .get();
  return row?.dnd ?? false;
}

/** Whether the owner blocked this caller or sender. Compared exactly as stored (E.164 or sender ID). */
export async function isBlocked(db: Db, ownerId: string, address: string): Promise<boolean> {
  if (!address) return false;
  const row = await db
    .select({ id: schema.blockedNumbers.id })
    .from(schema.blockedNumbers)
    .where(and(eq(schema.blockedNumbers.ownerId, ownerId), eq(schema.blockedNumbers.e164, address)))
    .get();
  return Boolean(row);
}

/** A fresh queue name: random, at most 64 characters as Twilio allows. */
export const newQueueName = () => `tq_${crypto.randomUUID().replace(/-/g, "")}`;

const voiceUrl = (env: Env, path: string) => `${new URL(env.PUBLIC_URL).origin}/api/twilio/voice${path}`;

/**
 * The voicemail TwiML of the shared contract: the greeting, a recording that reports to the voicemail route
 * (owned by the voicemail pipeline), then hang up.
 */
export function voicemailTwiml(env: Env, greeting: string | null): string {
  return response(
    el("Say", {}, text(greeting?.trim() || DEFAULT_GREETING)),
    el("Record", {
      maxLength: 120,
      playBeep: true,
      trim: "trim-silence",
      recordingStatusCallback: voiceUrl(env, "/voicemail"),
      recordingStatusCallbackEvent: "completed",
    }),
    el("Hangup"),
  );
}

/** The caller's TwiML while waiting for an answer: join the call's own queue with ringback. */
export function enqueueTwiml(env: Env, queueName: string): string {
  return response(
    el(
      "Enqueue",
      {
        action: voiceUrl(env, "/queue-done"),
        method: "POST",
        waitUrl: voiceUrl(env, "/queue-wait"),
        waitUrlMethod: "POST",
      },
      text(queueName),
    ),
  );
}

/** The owner's leg that answers: take the caller out of the call's queue. */
export function dequeueTwiml(env: Env, queueName: string, timeLimit: number): string {
  return response(
    el(
      "Dial",
      { timeLimit },
      el("Queue", { url: voiceUrl(env, "/queue-bridge"), method: "POST" }, text(queueName)),
    ),
  );
}

export function waitTwiml(env: Env, decision: ReturnType<typeof waitDecision>): string {
  if (decision.leave) return response(el("Leave"));
  const tone = `${new URL(env.PUBLIC_URL).origin}/sounds/ringback.wav`;
  return response(el("Play", {}, text(tone)), el("Pause", { length: decision.pause }));
}

/** Conditions under which a waiting call can still be answered or declined. */
const stillWaiting = (now: Date) =>
  and(
    eq(schema.calls.direction, "inbound"),
    isNull(schema.calls.outcome),
    isNull(schema.calls.endedAt),
    isNull(schema.calls.declinedAt),
    gt(schema.calls.startedAt, new Date(now.getTime() - WAITING_MAX_MS)),
  );

/**
 * Claims a waiting call for the owner's answering leg. Only the owner's own call, still waiting, not declined
 * and not claimed by another leg (a retry of the same leg gets the same answer). Returns the row with its
 * queue name, or null.
 */
export async function claimWaitingCall(
  db: Db,
  ownerId: string,
  callId: string,
  answerCallSid: string,
  now = new Date(),
): Promise<CallRow | null> {
  const row = await db
    .update(schema.calls)
    .set({ answerCallSid, answerClaimedAt: now })
    .where(
      and(
        eq(schema.calls.id, callId),
        eq(schema.calls.ownerId, ownerId),
        stillWaiting(now),
        or(isNull(schema.calls.answerCallSid), eq(schema.calls.answerCallSid, answerCallSid)),
      ),
    )
    .returning()
    .get();
  return row?.queueName ? row : null;
}

/** Declines a waiting call nobody answered yet. Returns the row, or null when it can no longer be declined. */
export async function declineWaitingCall(
  db: Db,
  ownerId: string,
  callId: string,
  now = new Date(),
): Promise<CallRow | null> {
  const row = await db
    .update(schema.calls)
    .set({ declinedAt: now })
    .where(
      and(
        eq(schema.calls.id, callId),
        eq(schema.calls.ownerId, ownerId),
        stillWaiting(now),
        isNull(schema.calls.answerCallSid),
      ),
    )
    .returning()
    .get();
  return row ?? null;
}

/** The owner's calls waiting in a queue right now, newest first. */
export async function waitingCalls(db: Db, ownerId: string, now = new Date()) {
  return db
    .select()
    .from(schema.calls)
    .where(
      and(
        eq(schema.calls.ownerId, ownerId),
        stillWaiting(now),
        isNull(schema.calls.answerCallSid),
        isNotNull(schema.calls.queueName),
      ),
    )
    .orderBy(desc(schema.calls.startedAt));
}

/** Sets an outcome on a call that has none yet. Returns the row when this write set it. */
export async function setOutcome(
  db: Db,
  callId: string,
  outcome: NonNullable<CallRow["outcome"]>,
): Promise<CallRow | null> {
  const row = await db
    .update(schema.calls)
    .set({ outcome })
    .where(and(eq(schema.calls.id, callId), isNull(schema.calls.outcome)))
    .returning()
    .get();
  return row ?? null;
}
