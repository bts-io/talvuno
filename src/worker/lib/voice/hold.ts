/**
 * Hold, resume and cold transfer of a live call. See docs/decisions.md (decision 13).
 *
 * A call has two legs that matter here. The owner's leg is the browser: the row's own CallSid on an outbound
 * call, the answering leg (answer_call_sid) on an inbound one. The remote leg is the other party: the dialed
 * child of an outbound call, the caller's own leg (the row's CallSid) on an inbound one.
 *
 *   hold      the remote leg is redirected into a queue of its own (`th_...`) with hold music. The owner's
 *             <Dial> ends, and its action answers with a quiet loop, so the browser stays connected.
 *   resume    the owner's leg is redirected to <Dial><Queue> of that hold queue.
 *   transfer  the remote leg is redirected to <Dial><Number> of the target, then the owner's leg is ended.
 *             The target leg's status callback (and the <Dial action>) record how it ended on the row.
 *   end       the owner leaves while the other party is held (hang-up button, or the browser leg's status
 *             callback): the held party hears a short message and is hung up, and the row is closed.
 *
 * A held party is never left waiting forever: after HOLD_MAX_MS the wait URL answers <Leave/>, the party
 * hears a short spoken message and the call ends. Hold queues are deleted when the party leaves them, and the
 * queue sweep removes any a missed webhook left behind.
 */
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import type { CallStatus } from "../../../contracts";
import type { Db } from "../../db";
import { schema } from "../../db";
import { TwilioApiError, type TwilioRest } from "../twilio/rest";
import type { CallRow } from "./call-rules";
import { applyCallEvent, onceWebhook } from "./calls";
import { el, response, text } from "./twiml";

export const HOLD_QUEUE_PREFIX = "th_";
/** How long a party may stay on hold before the call ends with a spoken message. */
export const HOLD_MAX_MS = 10 * 60 * 1000;
/** Twilio's free hold music (their public classical set, the same files as their default wait music). */
export const HOLD_MUSIC_URL = "https://s3.amazonaws.com/com.twilio.sounds.music/ClockworkWaltz.mp3";
/** Seconds of silence per round of the owner's hold loop. */
export const OWNER_HOLD_PAUSE_SECONDS = 20;
/** How long a transfer target may ring before the dial gives up. */
export const TRANSFER_RING_SECONDS = 30;
/** The shortest talk time a transfer gets, even when the call has almost used its own limit. */
export const TRANSFER_MIN_SECONDS = 60;

export const HOLD_SPOKEN = {
  timedOut: "Sorry, nobody came back to this call. Please call again later. Goodbye.",
  failed: "Sorry, this call could not continue. Goodbye.",
  transferFailed: "Sorry, the call could not be transferred. Goodbye.",
  ownerLeft: "The other person has left the call. Goodbye.",
} as const;

/** A fresh hold queue name: random, at most 64 characters as Twilio allows. */
export const newHoldQueueName = () => `th_${crypto.randomUUID().replace(/-/g, "")}`;

const holdUrl = (env: Env, path: string) => `${new URL(env.PUBLIC_URL).origin}/api/twilio/voice/hold${path}`;

// TwiML

/** The remote party's TwiML on hold: wait in the hold queue with music. */
export function holdEnqueueTwiml(env: Env, queueName: string): string {
  return response(
    el(
      "Enqueue",
      {
        action: holdUrl(env, "/done"),
        method: "POST",
        waitUrl: holdUrl(env, "/wait"),
        waitUrlMethod: "POST",
      },
      text(queueName),
    ),
  );
}

/** The hold queue's wait URL: music, or <Leave/> once the hold ran out. */
export const holdWaitTwiml = (leave: boolean) =>
  leave ? response(el("Leave")) : response(el("Play", {}, text(HOLD_MUSIC_URL)));

/** The owner's leg while the other party is on hold: silence, then ask again. */
export const ownerHoldTwiml = (env: Env) =>
  response(
    el("Pause", { length: OWNER_HOLD_PAUSE_SECONDS }),
    el("Redirect", { method: "POST" }, text(holdUrl(env, "/owner"))),
  );

/**
 * The owner's leg on resume: take the held party out of the hold queue. `dial` adds <Dial> attributes (the
 * number's recording ones), so a recorded call stays recorded after a hold.
 */
export function resumeTwiml(
  env: Env,
  queueName: string,
  timeLimit: number,
  dial: Record<string, string> = {},
): string {
  return response(
    el(
      "Dial",
      { timeLimit, action: holdUrl(env, "/owner"), method: "POST", ...dial },
      el("Queue", { url: holdUrl(env, "/bridge"), method: "POST" }, text(queueName)),
    ),
  );
}

/**
 * The remote party's TwiML on a cold transfer: dial the target from the call's own number. Both the <Dial
 * action> and the target leg's status callback name the call row, so either can record how the transfer ended.
 * It carries no recording attributes: the transfer target never heard a recording notice.
 */
export function transferTwiml(
  env: Env,
  callId: string,
  callerId: string,
  to: string,
  timeLimit: number,
): string {
  const call = `?call=${encodeURIComponent(callId)}`;
  return response(
    el(
      "Dial",
      {
        callerId,
        timeLimit,
        timeout: TRANSFER_RING_SECONDS,
        answerOnBridge: true,
        action: holdUrl(env, `/transfer-done${call}`),
        method: "POST",
      },
      el(
        "Number",
        {
          statusCallback: holdUrl(env, `/transfer-status${call}`),
          statusCallbackEvent: "completed",
          statusCallbackMethod: "POST",
        },
        text(to),
      ),
    ),
  );
}

/**
 * The talk time a transfer may have: what is left of the call's own limit since it was answered, never less
 * than TRANSFER_MIN_SECONDS. A transfer does not restart the clock.
 */
export function transferTimeLimit(row: CallRow, callLimitSeconds: number, now = Date.now()): number {
  const used = row.answeredAt ? Math.max(0, Math.floor((now - row.answeredAt.getTime()) / 1000)) : 0;
  return Math.max(TRANSFER_MIN_SECONDS, callLimitSeconds - used);
}

export const spokenEnd = (message: string) => response(el("Say", {}, text(message)), el("Hangup"));

// Rules

/** A call the owner can hold, resume or transfer: answered, still in progress, not handed on. */
export const isLiveCall = (row: CallRow) =>
  row.status === "in-progress" && Boolean(row.answeredAt) && !row.endedAt && !row.transferredTo;

/** Whether a hold that started at `onHoldAt` (or has lasted `queueSeconds`) has run out. */
export function holdExpired(onHoldAt: Date | null, queueSeconds: number, now = Date.now()): boolean {
  const held = onHoldAt ? now - onHoldAt.getTime() : 0;
  return Math.max(held, queueSeconds * 1000) >= HOLD_MAX_MS;
}

/** The owner's leg: the browser. */
export const ownerLegSid = (row: CallRow) =>
  row.direction === "outbound" ? row.twilioCallSid : row.answerCallSid;

// Rows

/** The owner's call named by its id or by one of its leg SIDs (the browser only knows its own CallSid). */
export async function findOwnerCall(db: Db, ownerId: string, ref: string): Promise<CallRow | null> {
  const c = schema.calls;
  const row = await db
    .select()
    .from(c)
    .where(and(eq(c.ownerId, ownerId), or(eq(c.id, ref), eq(c.twilioCallSid, ref), eq(c.answerCallSid, ref))))
    .get();
  return row ?? null;
}

/** The row whose owner leg (browser) has this CallSid. */
export async function findCallByOwnerLeg(db: Db, sid: string): Promise<CallRow | null> {
  const c = schema.calls;
  const row = await db
    .select()
    .from(c)
    .where(
      or(
        and(eq(c.direction, "outbound"), eq(c.twilioCallSid, sid)),
        and(eq(c.direction, "inbound"), eq(c.answerCallSid, sid)),
      ),
    )
    .get();
  return row ?? null;
}

/** The row whose remote leg (the other party) has this CallSid. */
export async function findCallByRemoteLeg(db: Db, sid: string): Promise<CallRow | null> {
  const c = schema.calls;
  const row = await db
    .select()
    .from(c)
    .where(
      or(
        and(eq(c.direction, "inbound"), eq(c.twilioCallSid, sid)),
        and(eq(c.direction, "outbound"), eq(c.remoteCallSid, sid)),
      ),
    )
    .get();
  return row ?? null;
}

type TwilioCall = { sid?: string; status?: string };

/**
 * The remote leg's CallSid. Inbound: the caller's own leg. Outbound: the dialed child in progress, asked from
 * Twilio once and kept on the row. Null when there is none (the other party already hung up).
 */
export async function remoteLegSid(db: Db, rest: TwilioRest, row: CallRow): Promise<string | null> {
  if (row.direction === "inbound") return row.twilioCallSid;
  if (row.remoteCallSid) return row.remoteCallSid;
  const page = await rest.get<{ calls?: TwilioCall[] }>("/Calls.json", {
    ParentCallSid: row.twilioCallSid,
    Status: "in-progress",
    PageSize: 5,
  });
  const sid = page.calls?.find((c) => c.sid && /^CA[0-9a-f]{32}$/i.test(c.sid))?.sid ?? null;
  if (sid) await db.update(schema.calls).set({ remoteCallSid: sid }).where(eq(schema.calls.id, row.id));
  return sid;
}

/** Marks the call held in a new hold queue. Null when it is no longer live or is held already. */
export async function markHeld(db: Db, row: CallRow, queueName: string, now = new Date()) {
  const c = schema.calls;
  return (
    (await db
      .update(c)
      .set({ onHoldAt: now, holdQueue: queueName })
      .where(
        and(
          eq(c.id, row.id),
          isNull(c.onHoldAt),
          isNull(c.endedAt),
          isNull(c.transferredTo),
          isNotNull(c.answeredAt),
        ),
      )
      .returning()
      .get()) ?? null
  );
}

/** Takes the hold off. Null when the call was not held (or ended). */
export async function clearHeld(db: Db, row: CallRow) {
  const c = schema.calls;
  return (
    (await db
      .update(c)
      .set({ onHoldAt: null })
      .where(and(eq(c.id, row.id), isNotNull(c.onHoldAt), isNull(c.endedAt)))
      .returning()
      .get()) ?? null
  );
}

/** Puts back a hold state after a Twilio request failed. */
export async function restoreHold(db: Db, id: string, onHoldAt: Date | null, holdQueue: string | null) {
  await db.update(schema.calls).set({ onHoldAt, holdQueue }).where(eq(schema.calls.id, id));
}

/** Records the transfer. Null when the call ended or was transferred already. */
export async function markTransferred(db: Db, row: CallRow, to: string, now = new Date()) {
  const c = schema.calls;
  return (
    (await db
      .update(c)
      .set({ transferredTo: to, transferredAt: now, onHoldAt: null })
      .where(and(eq(c.id, row.id), isNull(c.transferredTo), isNull(c.endedAt)))
      .returning()
      .get()) ?? null
  );
}

export async function undoTransfer(db: Db, row: CallRow) {
  await db
    .update(schema.calls)
    .set({ transferredTo: null, transferredAt: null, onHoldAt: row.onHoldAt })
    .where(eq(schema.calls.id, row.id));
}

/** Records how the transfer leg ended. The first report wins: the status callback and the <Dial action> both send one. */
export async function recordTransferEnd(
  db: Db,
  callId: string,
  end: { status: CallStatus; duration: number | null; at: Date },
): Promise<CallRow | null> {
  const c = schema.calls;
  return (
    (await db
      .update(c)
      .set({ transferStatus: end.status, transferDuration: end.duration ?? 0, transferEndedAt: end.at })
      .where(and(eq(c.id, callId), isNotNull(c.transferredTo), isNull(c.transferEndedAt)))
      .returning()
      .get()) ?? null
  );
}

/** A call whose held party must be let go when the owner leaves: on hold, not handed on. */
export const isHeldCall = (row: CallRow) => Boolean(row.onHoldAt) && !row.transferredTo;

/**
 * The owner left while the other party was on hold. The row is closed like any answered call that ends
 * (completed, its talk time, the answered outcome), then the held party is taken out of the hold queue to a
 * short spoken goodbye. Runs once per call through webhook_events, whichever of the hang-up request and the
 * browser leg's status callback comes first. A failed attempt is not marked done, so the next one tries again.
 */
export async function endHeldCall(
  env: Env,
  db: Db,
  rest: TwilioRest,
  row: CallRow,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  if (!isHeldCall(row)) return;
  await onceWebhook(db, `hold-end:${row.id}`, "hold-end", { callId: row.id }, async () => {
    // Closed first, so the hold queue's wait URL lets the party go even if Twilio refuses the redirect below.
    await applyCallEvent(
      env,
      db,
      row.twilioCallSid,
      { leg: "dial", status: "completed", at: new Date() },
      { ctx },
    );
    const remote = row.direction === "inbound" ? row.twilioCallSid : row.remoteCallSid;
    if (!remote) return;
    try {
      await redirectLeg(rest, remote, spokenEnd(HOLD_SPOKEN.ownerLeft));
    } catch (err) {
      if (isGoneLeg(err)) return;
      // Twilio refused the redirect for another reason: end the leg without the message.
      try {
        await endLeg(rest, remote);
      } catch (endErr) {
        if (!isGoneLeg(endErr)) throw endErr;
      }
    }
  });
}

/** Twilio says this call is not there or not in progress any more. */
export const isGoneLeg = (err: unknown) =>
  err instanceof TwilioApiError && (err.status === 404 || err.code === 21220);

/** Redirects a live leg to `twiml`. */
export const redirectLeg = (rest: TwilioRest, sid: string, twiml: string) =>
  rest.post(`/Calls/${encodeURIComponent(sid)}.json`, { Twiml: twiml });

/** Ends a leg. */
export const endLeg = (rest: TwilioRest, sid: string) =>
  rest.post(`/Calls/${encodeURIComponent(sid)}.json`, { Status: "completed" });
