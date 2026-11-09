/**
 * Voice webhooks, mounted at /api/twilio/voice. The parent router has already checked X-Twilio-Signature.
 * See src/worker/lib/voice/calls.ts for which SID a call row is keyed by and how status events apply.
 *
 *   POST /outbound           TwiML App Voice URL: the browser places a call
 *   POST /outbound-complete  <Dial action> of an outbound call
 *   POST /inbound            number's voice URL: someone calls one of our numbers
 *   POST /inbound-complete   <Dial action> of an inbound call
 *   POST /status             status callbacks of every leg
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { isTerminalCallStatus } from "../../contracts";
import { schema } from "../db";
import { findContactByNumber } from "../lib/contacts";
import { ApiError } from "../lib/errors";
import { notifyOwner } from "../lib/hub";
import { assertCanContact } from "../lib/twilio/guards";
import {
  applyCallEvent,
  findCall,
  isWithheld,
  onceWebhook,
  parseCallStatus,
  parseDialStatus,
  parseDuration,
  parseErrorCode,
  parseErrorMessage,
} from "../lib/voice/calls";
import { ownerFromClient, voiceIdentity } from "../lib/voice/identity";
import { defaultNumber, numberByE164, ownNumber } from "../lib/voice/numbers";
import { el, response, STATUS_EVENTS, sayAndHangUp, text, twimlResponse } from "../lib/voice/twiml";
import type { AppEnv } from "../types";

/** The longest one call may run, in seconds (2 hours), for outbound and inbound alike. */
export const CALL_TIME_LIMIT_SECONDS = 7_200;
/** How long an incoming call rings the browser before it counts as missed. */
export const INBOUND_RING_SECONDS = 25;

export const SPOKEN = {
  notAllowed: "This call is not allowed.",
  invalidNumber: "That number cannot be called.",
  premium: "Premium rate numbers cannot be called.",
  country: "Calls to that country are not turned on.",
  limit: "The hourly call limit has been reached. Please try again later.",
  noNumber: "There is no phone number set up to call from.",
  callerId: "That caller ID cannot be used.",
  unavailable: "Sorry, no one is available to take your call. Please try again later.",
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

/**
 * The <Dial> result (DialCallStatus) is the dial's outcome: it closes the row, then the call ends. For an
 * inbound call the caller hears the unavailable message only when the dial was not answered, decided from
 * DialCallStatus itself (as Titan does), so a caller whose call was answered and then ended by the owner
 * never hears it.
 */
async function dialComplete(c: Context<AppEnv>, type: "outbound" | "inbound") {
  const p = await form(c);
  const db = c.get("db");
  const callSid = p.CallSid;
  const status = parseDialStatus(p.DialCallStatus);
  if (callSid && status) {
    await onceWebhook(db, `voice-dial:${callSid}:${status}`, `voice-${type}-complete`, p, async () => {
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
  if (type === "inbound" && status !== "completed") return twimlResponse(sayAndHangUp(SPOKEN.unavailable));
  return twimlResponse(response(el("Hangup")));
}

twilioVoice.post("/outbound-complete", (c) => dialComplete(c, "outbound"));
twilioVoice.post("/inbound-complete", (c) => dialComplete(c, "inbound"));

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
  const contact = isWithheld(party) ? null : await findContactByNumber(db, ownerId, party);
  const row = await db
    .insert(schema.calls)
    .values({
      ownerId,
      twilioCallSid: callSid,
      direction: "inbound",
      numberId: number.id,
      party,
      status: parseCallStatus(p.CallStatus) ?? "ringing",
      startedAt: new Date(),
      contactId: contact?.id ?? null,
    })
    .onConflictDoNothing()
    .returning()
    .get();
  if (row)
    await notifyOwner(c.env, ownerId, { type: "call", callId: row.id, status: row.status }, c.executionCtx);
  const callId = row?.id ?? (await findCall(db, callSid))?.id ?? "";

  return twimlResponse(
    response(
      el(
        "Dial",
        {
          timeout: INBOUND_RING_SECONDS,
          answerOnBridge: true,
          timeLimit: CALL_TIME_LIMIT_SECONDS,
          action: url(c.env, "/inbound-complete"),
          method: "POST",
        },
        el(
          "Client",
          {
            statusCallback: url(c.env, "/status"),
            statusCallbackEvent: STATUS_EVENTS,
            statusCallbackMethod: "POST",
          },
          el("Identity", {}, text(voiceIdentity(ownerId))) +
            el("Parameter", { name: "callId", value: callId }) +
            el("Parameter", { name: "numberId", value: number.id }) +
            (contact ? el("Parameter", { name: "contactName", value: contact.displayName }) : ""),
        ),
      ),
    ),
  );
});

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
