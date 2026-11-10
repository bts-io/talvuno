/**
 * Voice webhooks, mounted at /api/twilio/voice. The parent router has already checked X-Twilio-Signature.
 * See src/worker/lib/voice/calls.ts for which SID a call row is keyed by and how status events apply.
 *
 *   POST /outbound           TwiML App Voice URL: the browser places a call, or answers a waiting one
 *   POST /outbound-complete  <Dial action> of an outbound call
 *   POST /inbound            number's voice URL: someone calls one of our numbers (see lib/voice/routing.ts)
 *   POST /queue-wait         <Enqueue waitUrl>: ringback while the caller waits
 *   POST /queue-bridge       <Queue url>: the caller is about to be bridged to the answering device
 *   POST /queue-done         <Enqueue action>: the caller left the queue (voicemail, or the call ended)
 *   POST /status             status callbacks of every leg
 *
 * /voicemail (the recording status callback) belongs to the voicemail pipeline and is not mounted here.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { isTerminalCallStatus } from "../../contracts";
import { schema } from "../db";
import { findContactByNumber } from "../lib/contacts";
import { ApiError } from "../lib/errors";
import { notifyOwner } from "../lib/hub";
import { assertCanContact } from "../lib/twilio/guards";
import { twilioRest } from "../lib/twilio/rest";
import {
  applyCallEvent,
  type CallRow,
  findCall,
  incomingCallPush,
  isWithheld,
  onceWebhook,
  parseCallStatus,
  parseDialStatus,
  parseDuration,
  parseErrorCode,
  parseErrorMessage,
} from "../lib/voice/calls";
import { ownerFromClient } from "../lib/voice/identity";
import { defaultNumber, numberByE164, ownNumber } from "../lib/voice/numbers";
import {
  claimWaitingCall,
  decideInbound,
  dequeueTwiml,
  enqueueTwiml,
  isBlocked,
  isDndOn,
  newQueueName,
  numberRouting,
  setOutcome,
  voicemailTwiml,
  waitDecision,
  waitTwiml,
} from "../lib/voice/routing";
import { el, response, STATUS_EVENTS, sayAndHangUp, text, twimlResponse } from "../lib/voice/twiml";
import type { AppEnv } from "../types";

/** The longest one call may run, in seconds (2 hours), for outbound and inbound alike. */
export const CALL_TIME_LIMIT_SECONDS = 7_200;

export const SPOKEN = {
  notAllowed: "This call is not allowed.",
  invalidNumber: "That number cannot be called.",
  premium: "Premium rate numbers cannot be called.",
  country: "Calls to that country are not turned on.",
  limit: "The hourly call limit has been reached. Please try again later.",
  noNumber: "There is no phone number set up to call from.",
  callerId: "That caller ID cannot be used.",
  answeredElsewhere: "This call was answered on another device or has ended.",
} as const;

const REFUSAL_BY_CODE: Record<string, string> = {
  invalid_number: SPOKEN.invalidNumber,
  premium_rate: SPOKEN.premium,
  country_not_allowed: SPOKEN.country,
  rate_limited: SPOKEN.limit,
};

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

async function form(c: Context<AppEnv>): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
  return out;
}

const url = (env: Env, path: string) => `${new URL(env.PUBLIC_URL).origin}/api/twilio/voice${path}`;

const refuse = (c: Context<AppEnv>, reason: string, message: string, callSid?: string) => {
  console.warn("voice call refused", { reason, callSid, requestId: c.get("requestId") });
  return twimlResponse(sayAndHangUp(message));
};

export const twilioVoice = new Hono<AppEnv>();

twilioVoice.post("/outbound", async (c) => {
  const p = await form(c);
  const db = c.get("db");
  const callSid = p.CallSid;
  if (!callSid) return refuse(c, "no CallSid", SPOKEN.notAllowed);

  const ownerId = await ownerFromClient(db, p.From);
  if (!ownerId) return refuse(c, "unknown identity", SPOKEN.notAllowed, callSid);

  // Answering a waiting inbound call: the device names the call row, the server checks it is this owner's,
  // still waiting and not claimed by another device, and only then hands Twilio the queue name.
  const answerId = p.AnswerCallId?.trim();
  if (answerId) {
    const row = await claimWaitingCall(db, ownerId, answerId, callSid);
    if (!row?.queueName) return refuse(c, "answer refused", SPOKEN.answeredElsewhere, callSid);
    return twimlResponse(dequeueTwiml(c.env, row.queueName, CALL_TIME_LIMIT_SECONDS));
  }
  const to = p.To ?? "";

  // The caller ID: absent means the default number; anything given must be one of ours.
  const requested = p.CallerId?.trim();
  const from = requested ? await ownNumber(db, ownerId, requested) : await defaultNumber(db, ownerId);
  if (!from)
    return refuse(
      c,
      requested ? "foreign caller id" : "no number",
      requested ? SPOKEN.callerId : SPOKEN.noNumber,
      callSid,
    );

  // A retry of the same request must not spend a second call from the hourly budget.
  const existing = await findCall(db, callSid);
  if (!existing) {
    try {
      await assertCanContact(c, ownerId, to, "call");
    } catch (err) {
      if (err instanceof ApiError)
        return refuse(c, err.code, REFUSAL_BY_CODE[err.code] ?? SPOKEN.notAllowed, callSid);
      throw err;
    }
    const contact = await findContactByNumber(db, ownerId, to);
    const row = await db
      .insert(schema.calls)
      .values({
        ownerId,
        twilioCallSid: callSid,
        direction: "outbound",
        numberId: from.id,
        party: to,
        status: "queued",
        startedAt: new Date(),
        contactId: contact?.id ?? null,
      })
      .onConflictDoNothing()
      .returning()
      .get();
    if (row)
      await notifyOwner(c.env, ownerId, { type: "call", callId: row.id, status: row.status }, c.executionCtx);
  } else if (existing.ownerId !== ownerId || existing.party !== to) {
    return refuse(c, "call sid reused", SPOKEN.notAllowed, callSid);
  }

  return twimlResponse(
    response(
      el(
        "Dial",
        {
          callerId: from.e164,
          answerOnBridge: true,
          timeLimit: CALL_TIME_LIMIT_SECONDS,
          action: url(c.env, "/outbound-complete"),
          method: "POST",
        },
        el(
          "Number",
          {
            statusCallback: url(c.env, "/status"),
            statusCallbackEvent: STATUS_EVENTS,
            statusCallbackMethod: "POST",
          },
          text(to),
        ),
      ),
    ),
  );
});

/** The <Dial> result (DialCallStatus) of an outbound call is its outcome: it closes the row, then the call ends. */
twilioVoice.post("/outbound-complete", async (c) => {
  const p = await form(c);
  const db = c.get("db");
  const callSid = p.CallSid;
  const status = parseDialStatus(p.DialCallStatus);
  if (callSid && status) {
    await onceWebhook(db, `voice-dial:${callSid}:${status}`, "voice-outbound-complete", p, async () => {
      await applyCallEvent(
        c.env,
        db,
        callSid,
        {
          leg: "dial",
          status,
          duration: parseDuration(p.DialCallDuration),
          errorCode: parseErrorCode(p.ErrorCode),
          errorMessage: parseErrorMessage(p.ErrorMessage),
          at: new Date(),
        },
        { ctx: c.executionCtx },
      );
    });
  }
  return twimlResponse(response(el("Hangup")));
});

/** Tells every open screen that a waiting call stopped ringing (answered, declined, voicemail, hung up). */
const incomingEnded = (c: Context<AppEnv>, row: Pick<CallRow, "id" | "ownerId">) =>
  notifyOwner(c.env, row.ownerId, { type: "incoming", callId: row.id, state: "ended" }, c.executionCtx);

twilioVoice.post("/inbound", async (c) => {
  const p = await form(c);
  const db = c.get("db");
  const callSid = p.CallSid;
  const number = p.To ? await numberByE164(db, p.To) : null;
  if (!callSid || !number) {
    console.warn("inbound call to an unknown number refused", { requestId: c.get("requestId") });
    return twimlResponse(response(el("Reject")));
  }
  const ownerId = number.ownerId;
  // Withheld callers arrive as "anonymous" and the like; stored as received.
  const party = (p.From ?? "").trim() || "anonymous";
  const now = new Date();

  // A retry of the same request answers from the stored row, so the caller never gets a second queue.
  const existing = await findCall(db, callSid);
  if (existing) {
    if (existing.ownerId !== ownerId) return twimlResponse(response(el("Reject")));
    if (existing.outcome === "blocked") return twimlResponse(response(el("Reject", { reason: "rejected" })));
    const routing = await numberRouting(db, ownerId, existing.numberId);
    if (existing.queueName && !existing.outcome)
      return twimlResponse(enqueueTwiml(c.env, existing.queueName));
    return twimlResponse(voicemailTwiml(c.env, routing.voicemailGreeting));
  }

  const routing = await numberRouting(db, ownerId, number.id);
  const route = decideInbound({
    blocked: !isWithheld(party) && (await isBlocked(db, ownerId, party)),
    dnd: await isDndOn(db, ownerId),
    hours: routing.hours,
    at: now,
  });
  const contact = isWithheld(party) ? null : await findContactByNumber(db, ownerId, party);
  const base = {
    ownerId,
    twilioCallSid: callSid,
    direction: "inbound" as const,
    numberId: number.id,
    party,
    startedAt: now,
    contactId: contact?.id ?? null,
  };

  if (route === "reject") {
    // Recorded for history as blocked: never missed, never pushed.
    const row = await db
      .insert(schema.calls)
      .values({ ...base, status: "busy", outcome: "blocked", endedAt: now, duration: 0 })
      .onConflictDoNothing()
      .returning()
      .get();
    if (row)
      await notifyOwner(c.env, ownerId, { type: "call", callId: row.id, status: row.status }, c.executionCtx);
    return twimlResponse(response(el("Reject", { reason: "rejected" })));
  }

  if (route === "voicemail") {
    // Outside hours or do not disturb: no ring, no push. The live event only refreshes Recents.
    const row = await db
      .insert(schema.calls)
      .values({ ...base, status: parseCallStatus(p.CallStatus) ?? "ringing", outcome: "voicemail" })
      .onConflictDoNothing()
      .returning()
      .get();
    if (row)
      await notifyOwner(c.env, ownerId, { type: "call", callId: row.id, status: row.status }, c.executionCtx);
    return twimlResponse(voicemailTwiml(c.env, routing.voicemailGreeting));
  }

  const queueName = newQueueName();
  const row = await db
    .insert(schema.calls)
    .values({ ...base, status: parseCallStatus(p.CallStatus) ?? "ringing", queueName })
    .onConflictDoNothing()
    .returning()
    .get();
  if (!row) {
    // A parallel retry inserted first: join the queue it chose.
    const raced = await findCall(db, callSid);
    return twimlResponse(
      raced?.queueName
        ? enqueueTwiml(c.env, raced.queueName)
        : voicemailTwiml(c.env, routing.voicemailGreeting),
    );
  }
  const contactName = contact?.displayName ?? null;
  await notifyOwner(
    c.env,
    ownerId,
    {
      type: "incoming",
      callId: row.id,
      state: "ringing",
      party,
      contactName,
      numberId: number.id,
      push: incomingCallPush(row, contactName, routing.ringSeconds),
    },
    c.executionCtx,
    { alwaysPush: true },
  );
  return twimlResponse(enqueueTwiml(c.env, queueName));
});

/** The queue's waitUrl: ringback until the ring time is up or the owner declines, then <Leave/>. */
twilioVoice.post("/queue-wait", async (c) => {
  const p = await form(c);
  const db = c.get("db");
  const row = p.CallSid ? await findCall(db, p.CallSid) : null;
  const queueTime = parseDuration(p.QueueTime) ?? 0;
  const routing = row ? await numberRouting(db, row.ownerId, row.numberId) : null;
  return twimlResponse(
    waitTwiml(
      c.env,
      waitDecision(row?.direction === "inbound" ? row : null, queueTime, routing?.ringSeconds ?? 0),
    ),
  );
});

/**
 * Runs on the caller just before the bridge to the owner's answering leg (the <Queue url>). This is the
 * answer: the row gets its answer time and the answered outcome, and every other screen stops ringing.
 */
twilioVoice.post("/queue-bridge", async (c) => {
  const p = await form(c);
  const db = c.get("db");
  const callSid = p.CallSid;
  const row = callSid ? await findCall(db, callSid) : null;
  if (callSid && row?.direction === "inbound") {
    await onceWebhook(db, `voice-bridge:${callSid}`, "voice-queue-bridge", p, async () => {
      await applyCallEvent(
        c.env,
        db,
        callSid,
        { leg: "dial", status: "in-progress", at: new Date() },
        { ctx: c.executionCtx },
      );
      await setOutcome(db, row.id, "answered");
      await incomingEnded(c, row);
    });
  }
  return twimlResponse(response());
});

/**
 * The <Enqueue action>: the caller left the queue. Left on purpose (ring time up, or declined) means
 * voicemail. Anything else (bridged and done, hung up) ends the call. The queue is deleted either way, since
 * Twilio keeps queues until they are removed.
 */
twilioVoice.post("/queue-done", async (c) => {
  const p = await form(c);
  const db = c.get("db");
  const row = p.CallSid ? await findCall(db, p.CallSid) : null;
  const queueSid = str(p.QueueSid);
  if (queueSid && /^QU[0-9a-f]{32}$/i.test(queueSid)) c.executionCtx.waitUntil(deleteQueue(c.env, queueSid));
  if (row?.direction !== "inbound") return twimlResponse(response(el("Hangup")));
  if (p.QueueResult === "leave") {
    await setOutcome(db, row.id, row.declinedAt ? "declined" : "voicemail");
    await incomingEnded(c, row);
    const routing = await numberRouting(db, row.ownerId, row.numberId);
    return twimlResponse(voicemailTwiml(c.env, routing.voicemailGreeting));
  }
  if (p.QueueResult !== "bridged") await incomingEnded(c, row);
  return twimlResponse(response(el("Hangup")));
});

async function deleteQueue(env: Env, queueSid: string) {
  try {
    await twilioRest(env).delete(`/Queues/${queueSid}.json`);
  } catch (err) {
    // A queue left behind costs nothing and holds no caller; it is only tidied away.
    console.warn("queue delete failed", { queueSid, error: String(err) });
  }
}

twilioVoice.post("/status", async (c) => {
  const p = await form(c);
  const db = c.get("db");
  const callSid = str(p.CallSid);
  const status = parseCallStatus(p.CallStatus);
  if (callSid && status) {
    const parent = str(p.ParentCallSid);
    const rowSid = parent || callSid;
    await onceWebhook(db, `voice-status:${callSid}:${status}`, "voice-status", p, async () => {
      await applyCallEvent(
        c.env,
        db,
        rowSid,
        {
          leg: parent ? "child" : "parent",
          status,
          duration: isTerminalCallStatus(status) ? parseDuration(p.CallDuration) : null,
          errorCode: parseErrorCode(p.ErrorCode),
          errorMessage: parseErrorMessage(p.ErrorMessage),
          at: new Date(),
        },
        { ctx: c.executionCtx },
      );
    });
  }
  return twimlResponse(response());
});
