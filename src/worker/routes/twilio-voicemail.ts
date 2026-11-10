/**
 * The voicemail recording status callback, mounted at /api/twilio/voice/voicemail. The parent router has
 * already checked X-Twilio-Signature. The <Record> TwiML that leads here asks only for the "completed" event.
 *
 * The handler records the voicemail row and answers 204 at once. Downloading the audio into R2, deleting the
 * Twilio copy, queueing the transcript and the notice run after the response (src/worker/lib/voicemail).
 */
import { Hono } from "hono";
import { schema } from "../db";
import { findCall, onceWebhook, parseDuration } from "../lib/voice/calls";
import { storeVoicemail } from "../lib/voicemail";
import type { AppEnv } from "../types";

const RECORDING_SID = /^RE[0-9a-f]{32}$/i;

export const twilioVoicemail = new Hono<AppEnv>();

twilioVoicemail.post("/", async (c) => {
  const body = await c.req.parseBody();
  const p: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") p[k] = v;
  const db = c.get("db");
  const { CallSid: callSid, RecordingSid: recordingSid, RecordingStatus: status } = p;

  if (status !== "completed" || !callSid || !recordingSid || !RECORDING_SID.test(recordingSid)) {
    console.warn("voicemail callback ignored", { status, requestId: c.get("requestId") });
    return c.body(null, 204);
  }

  await onceWebhook(db, `voicemail:${recordingSid}`, "voice-voicemail", p, async () => {
    const call = await findCall(db, callSid);
    // Throwing records the error and answers 500, so Twilio tries again. The recording stays on Twilio.
    if (!call) throw new Error("voicemail for an unknown call");
    const row = await db
      .insert(schema.voicemails)
      .values({
        ownerId: call.ownerId,
        callId: call.id,
        numberId: call.numberId,
        from: call.party,
        duration: parseDuration(p.RecordingDuration),
        twilioRecordingSid: recordingSid,
      })
      .onConflictDoNothing()
      .returning()
      .get();
    if (!row) {
      console.warn("second recording for one call left on Twilio", { callId: call.id });
      return;
    }
    c.executionCtx.waitUntil(storeVoicemail(c.env, db, row, c.executionCtx));
  });
  return c.body(null, 204);
});
