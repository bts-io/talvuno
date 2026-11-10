/**
 * Owner controls for a live call, mounted at /api/calls (session and Origin checks apply).
 *
 *   POST /:ref/hold      put the other party on hold with music
 *   POST /:ref/resume    take them off hold
 *   POST /:ref/transfer  hand the call to another number ({ to }), then end the owner's leg
 *   POST /:ref/hangup    the owner is hanging up: a held party is let go with a short message, the row closes
 *
 * `ref` is the call's id or one of its leg CallSids, because the browser knows its own CallSid first. Each
 * request is owner-only and idempotent: holding a held call, resuming a call that is not held, or repeating
 * a transfer to the same number answers with the current state and changes nothing.
 */
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { type CallControlResult, transferBodySchema } from "../../contracts/call-control";
import { toE164 } from "../../lib/phone";
import { schema } from "../db";
import { ApiError } from "../lib/errors";
import { notifyOwner } from "../lib/hub";
import { assertCanContact } from "../lib/twilio/guards";
import { TwilioNotConfiguredError, type TwilioRest, twilioRest } from "../lib/twilio/rest";
import { validationHook } from "../lib/validation";
import type { CallRow } from "../lib/voice/calls";
import {
  clearHeld,
  endHeldCall,
  endLeg,
  findOwnerCall,
  holdEnqueueTwiml,
  isGoneLeg,
  isHeldCall,
  isLiveCall,
  markHeld,
  markTransferred,
  newHoldQueueName,
  ownerLegSid,
  redirectLeg,
  remoteLegSid,
  restoreHold,
  resumeTwiml,
  transferTimeLimit,
  transferTwiml,
  undoTransfer,
} from "../lib/voice/hold";
import { dialRecordingAttrs, recordingSettings } from "../lib/voice/recording";
import type { AppEnv } from "../types";
import { CALL_TIME_LIMIT_SECONDS } from "./twilio-voice";

export const callControl = new Hono<AppEnv>();

const result = (row: CallRow): CallControlResult => ({
  id: row.id,
  onHold: Boolean(row.onHoldAt) && !row.endedAt,
  transferredTo: row.transferredTo ?? null,
});

const notLive = () => new ApiError(409, "not_live", "This call is not in progress");
const twilioFailed = () => new ApiError(502, "twilio_failed", "Twilio did not accept the change. Try again.");

function rest(env: Env): TwilioRest {
  try {
    return twilioRest(env);
  } catch (err) {
    if (err instanceof TwilioNotConfiguredError)
      throw new ApiError(503, "not_configured", "Calling is not set up on this server yet");
    throw err;
  }
}

async function ownerCall(c: Context<AppEnv>): Promise<CallRow> {
  const row = await findOwnerCall(c.get("db"), c.get("user")!.id, c.req.param("ref") ?? "");
  if (!row) throw new ApiError(404, "not_found", "Call not found");
  return row;
}

const changed = (c: Context<AppEnv>, row: CallRow) =>
  notifyOwner(c.env, row.ownerId, { type: "call", callId: row.id, status: row.status }, c.executionCtx);

callControl.post("/:ref/hold", async (c) => {
  const db = c.get("db");
  const row = await ownerCall(c);
  if (row.onHoldAt && !row.endedAt && !row.transferredTo) return c.json(result(row));
  if (!isLiveCall(row)) throw notLive();
  const twilio = rest(c.env);
  const remote = await remoteLegSid(db, twilio, row);
  if (!remote) throw notLive();

  const queue = newHoldQueueName();
  const held = await markHeld(db, row, queue);
  if (!held) {
    // A parallel request held it first, or the call just ended.
    const now = await findOwnerCall(db, row.ownerId, row.id);
    if (now?.onHoldAt && !now.endedAt) return c.json(result(now));
    throw notLive();
  }
  try {
    await redirectLeg(twilio, remote, holdEnqueueTwiml(c.env, queue));
  } catch (err) {
    await restoreHold(db, row.id, null, row.holdQueue);
    console.warn("hold failed", { callId: row.id, error: String(err) });
    if (isGoneLeg(err)) throw notLive();
    throw twilioFailed();
  }
  await changed(c, held);
  return c.json(result(held));
});

callControl.post("/:ref/resume", async (c) => {
  const db = c.get("db");
  const row = await ownerCall(c);
  if (!row.onHoldAt) {
    if (isLiveCall(row)) return c.json(result(row));
    throw notLive();
  }
  const owner = ownerLegSid(row);
  if (!owner || !row.holdQueue || row.endedAt) throw notLive();
  const twilio = rest(c.env);
  const resumed = await clearHeld(db, row);
  if (!resumed) {
    const now = await findOwnerCall(db, row.ownerId, row.id);
    if (now && isLiveCall(now)) return c.json(result(now));
    throw notLive();
  }
  try {
    const recording = await recordingSettings(db, row.ownerId, row.numberId);
    await redirectLeg(
      twilio,
      owner,
      resumeTwiml(c.env, row.holdQueue, CALL_TIME_LIMIT_SECONDS, dialRecordingAttrs(c.env, recording)),
    );
  } catch (err) {
    await restoreHold(db, row.id, row.onHoldAt, row.holdQueue);
    console.warn("resume failed", { callId: row.id, error: String(err) });
    if (isGoneLeg(err)) throw new ApiError(409, "owner_leg_ended", "This device is no longer on the call");
    throw twilioFailed();
  }
  await changed(c, resumed);
  return c.json(result(resumed));
});

callControl.post("/:ref/transfer", zValidator("json", transferBodySchema, validationHook), async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const row = await ownerCall(c);
  const to = toE164(c.req.valid("json").to);
  if (!to) throw new ApiError(400, "invalid_number", "Not a valid phone number");
  if (row.transferredTo) {
    if (row.transferredTo === to) return c.json(result(row));
    throw new ApiError(409, "already_transferred", "This call was already transferred");
  }
  if (row.endedAt || row.status !== "in-progress" || !row.answeredAt) throw notLive();

  // The call goes out from the number it is on, which must still be ours.
  const number = row.numberId
    ? await db
        .select()
        .from(schema.phoneNumbers)
        .where(and(eq(schema.phoneNumbers.id, row.numberId), eq(schema.phoneNumbers.ownerId, ownerId)))
        .get()
    : undefined;
  if (!number || number.releasedAt)
    throw new ApiError(409, "no_number", "This call has no number to transfer from");
  const own = await db
    .select({ id: schema.phoneNumbers.id })
    .from(schema.phoneNumbers)
    .where(and(eq(schema.phoneNumbers.ownerId, ownerId), eq(schema.phoneNumbers.e164, to)))
    .get();
  if (own) throw new ApiError(400, "own_number", "A call cannot be transferred to one of your own numbers");

  // Allowlist, premium-rate block and the hourly limit, like any call we place.
  await assertCanContact(c, ownerId, to, "call");
  const twilio = rest(c.env);
  const remote = await remoteLegSid(db, twilio, row);
  if (!remote) throw notLive();

  const marked = await markTransferred(db, row, to);
  if (!marked) {
    const now = await findOwnerCall(db, ownerId, row.id);
    if (now?.transferredTo === to) return c.json(result(now));
    throw notLive();
  }
  try {
    await redirectLeg(
      twilio,
      remote,
      transferTwiml(c.env, row.id, number.e164, to, transferTimeLimit(row, CALL_TIME_LIMIT_SECONDS)),
    );
  } catch (err) {
    await undoTransfer(db, row);
    console.warn("transfer failed", { callId: row.id, error: String(err) });
    if (isGoneLeg(err)) throw notLive();
    throw twilioFailed();
  }
  // The other party is on their way: the owner's leg is done. Its own <Dial action> hangs up too, so a failure
  // here only means it ends a moment later.
  const owner = ownerLegSid(row);
  if (owner)
    await endLeg(twilio, owner).catch((err) =>
      console.warn("owner leg end failed", { callId: row.id, error: String(err) }),
    );
  await changed(c, marked);
  return c.json(result(marked));
});

/**
 * The owner pressed hang up. Ending the browser leg alone would leave a held party in the hold queue, so a
 * held call is ended here first. Anything else is left to the browser leg ending as usual. Repeats are no-ops.
 */
callControl.post("/:ref/hangup", async (c) => {
  const db = c.get("db");
  const row = await ownerCall(c);
  if (!isHeldCall(row)) return c.json(result(row));
  const twilio = rest(c.env);
  try {
    await endHeldCall(c.env, db, twilio, row, c.executionCtx);
  } catch (err) {
    console.warn("held call end failed", { callId: row.id, error: String(err) });
    throw twilioFailed();
  }
  const now = await findOwnerCall(db, row.ownerId, row.id);
  return c.json(result(now ?? row));
});
