/**
 * Hold and transfer webhooks, mounted at /api/twilio/voice/hold. The parent router has already checked
 * X-Twilio-Signature. See src/worker/lib/voice/hold.ts for the legs and the flow.
 *
 *   POST /wait           hold queue waitUrl: hold music, <Leave/> once the hold ran out
 *   POST /done           hold queue <Enqueue action>: the held party left the queue
 *   POST /bridge         <Queue url> on resume: the held party is about to be bridged back to the owner
 *   POST /owner          the owner leg's <Dial action> and its hold loop: silence while held, else hang up
 *   POST /transfer-done    <Dial action> of a transfer: the transferred party's dial ended
 *   POST /transfer-status  status callback of the transfer target's leg: how it ended, its talk time
 *
 * Both transfer routes carry `?call=<row id>` and record the transfer leg's end on that row, the first one wins.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { type CallStatus, isTerminalCallStatus } from "../../contracts";
import { notifyOwner } from "../lib/hub";
import { twilioRest } from "../lib/twilio/rest";
import { onceWebhook, parseCallStatus, parseDialStatus, parseDuration } from "../lib/voice/calls";
import {
  findCallByOwnerLeg,
  findCallByRemoteLeg,
  HOLD_SPOKEN,
  holdExpired,
  holdWaitTwiml,
  ownerHoldTwiml,
  recordTransferEnd,
  spokenEnd,
} from "../lib/voice/hold";
import { el, response, twimlResponse } from "../lib/voice/twiml";
import type { AppEnv } from "../types";

async function form(c: Context<AppEnv>): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
  return out;
}

const hangUp = () => twimlResponse(response(el("Hangup")));

export const twilioHold = new Hono<AppEnv>();

twilioHold.post("/wait", async (c) => {
  const p = await form(c);
  const row = p.CallSid ? await findCallByRemoteLeg(c.get("db"), p.CallSid) : null;
  const queueSeconds = parseDuration(p.QueueTime) ?? 0;
  // An unknown leg or an ended call leaves at once. A resumed call keeps the music until the bridge, but
  // never past the cap.
  const leave = !row || Boolean(row.endedAt) || holdExpired(row.onHoldAt, queueSeconds);
  return twimlResponse(holdWaitTwiml(leave));
});

/** Results that mean the party was moved on by our own redirect (resume elsewhere, a transfer, a new hold). */
const REDIRECTED = new Set(["redirected", "redirected-from-bridged"]);
/** Results that end the call: the bridge ended (someone hung up) or the party hung up while held. */
const ENDS_CALL = new Set(["bridged", "bridging-in-process", "hangup"]);

twilioHold.post("/done", async (c) => {
  const p = await form(c);
  const queueSid = typeof p.QueueSid === "string" ? p.QueueSid : "";
  if (/^QU[0-9a-f]{32}$/i.test(queueSid)) c.executionCtx.waitUntil(deleteQueue(c.env, queueSid));
  const result = String(p.QueueResult);
  if (REDIRECTED.has(result)) return twimlResponse(response());
  if (ENDS_CALL.has(result)) return hangUp();
  const row = p.CallSid ? await findCallByRemoteLeg(c.get("db"), p.CallSid) : null;
  if (row)
    await notifyOwner(
      c.env,
      row.ownerId,
      { type: "call", callId: row.id, status: row.status },
      c.executionCtx,
    );
  // "leave" is the hold running out. Anything else (error, queue-full, system-error) could not hold.
  return twimlResponse(spokenEnd(result === "leave" ? HOLD_SPOKEN.timedOut : HOLD_SPOKEN.failed));
});

twilioHold.post("/bridge", async (c) => {
  const p = await form(c);
  const db = c.get("db");
  const row = p.CallSid ? await findCallByRemoteLeg(db, p.CallSid) : null;
  if (row && p.CallSid) {
    await onceWebhook(db, `hold-bridge:${p.CallSid}:${p.QueueSid ?? ""}`, "hold-bridge", p, async () => {
      await notifyOwner(
        c.env,
        row.ownerId,
        { type: "call", callId: row.id, status: row.status },
        c.executionCtx,
      );
    });
  }
  return twimlResponse(response());
});

twilioHold.post("/owner", async (c) => {
  const p = await form(c);
  const row = p.CallSid ? await findCallByOwnerLeg(c.get("db"), p.CallSid) : null;
  if (row?.onHoldAt && !row.endedAt && !row.transferredTo && !holdExpired(row.onHoldAt, 0))
    return twimlResponse(ownerHoldTwiml(c.env));
  return hangUp();
});

/** Records the transfer leg's end on the call named in the URL (`?call=<id>`, signed with the rest of it). */
async function transferEnded(
  c: Context<AppEnv>,
  key: string,
  p: Record<string, string>,
  status: CallStatus | null,
  duration: number | null,
) {
  const callId = c.req.query("call");
  if (!callId || !status || !isTerminalCallStatus(status)) return;
  const db = c.get("db");
  await onceWebhook(db, key, "hold-transfer-end", p, async () => {
    const row = await recordTransferEnd(db, callId, { status, duration, at: new Date() });
    if (row)
      await notifyOwner(
        c.env,
        row.ownerId,
        { type: "call", callId: row.id, status: row.status },
        c.executionCtx,
      );
  });
}

twilioHold.post("/transfer-done", async (c) => {
  const p = await form(c);
  const status = parseDialStatus(p.DialCallStatus);
  await transferEnded(
    c,
    `hold-transfer-done:${p.CallSid ?? ""}:${p.DialCallSid ?? ""}:${status ?? ""}`,
    p,
    status,
    parseDuration(p.DialCallDuration),
  );
  if (status === "completed") return hangUp();
  return twimlResponse(spokenEnd(HOLD_SPOKEN.transferFailed));
});

/** The target leg's own status callback: how the transfer ended and how long it talked. */
twilioHold.post("/transfer-status", async (c) => {
  const p = await form(c);
  const status = parseCallStatus(p.CallStatus);
  await transferEnded(
    c,
    `hold-transfer-status:${p.CallSid ?? ""}:${status ?? ""}`,
    p,
    status,
    parseDuration(p.CallDuration),
  );
  return twimlResponse(response());
});

async function deleteQueue(env: Env, queueSid: string) {
  try {
    await twilioRest(env).delete(`/Queues/${queueSid}.json`);
  } catch (err) {
    // The queue sweep removes what this misses.
    console.warn("hold queue delete failed", { queueSid, error: String(err) });
  }
}
