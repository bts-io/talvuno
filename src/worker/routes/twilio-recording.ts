/**
 * Call recording webhooks, mounted at /api/twilio/voice/recording. The parent router has already checked
 * X-Twilio-Signature.
 *
 *   POST /         recording status callback of a recorded call (a <Dial record> or a recording started from
 *                  the call screen). Only "completed" is asked for.
 *   POST /notice   the <Number url> whisper of an outbound recorded call: the notice to the called party,
 *                  after they answer and before the bridge
 *
 * The callback records the call_recordings row and answers 204 at once. Storing the audio in R2, deleting the
 * Twilio copy and queueing the transcript run after the response (lib/recordings/store.ts).
 */
import { Hono } from "hono";
import { schema } from "../db";
import { storeAudio } from "../lib/recordings/store";
import { onceWebhook, parseDuration } from "../lib/voice/calls";
import {
  callForRecording,
  callRecordingPipeline,
  noticeSay,
  recordingSettings,
} from "../lib/voice/recording";
import { response, twimlResponse } from "../lib/voice/twiml";
import type { AppEnv } from "../types";

const RECORDING_SID = /^RE[0-9a-f]{32}$/i;

export const twilioRecording = new Hono<AppEnv>();

async function form(body: Record<string, unknown>) {
  const p: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") p[k] = v;
  return p;
}

twilioRecording.post("/", async (c) => {
  const p = await form(await c.req.parseBody());
  const db = c.get("db");
  const { CallSid: callSid, RecordingSid: recordingSid, RecordingStatus: status } = p;

  if (status !== "completed" || !callSid || !recordingSid || !RECORDING_SID.test(recordingSid)) {
    console.warn("recording callback ignored", { status, requestId: c.get("requestId") });
    return c.body(null, 204);
  }

  await onceWebhook(db, `recording:${recordingSid}`, "voice-recording", p, async () => {
    const call = await callForRecording(db, callSid);
    // Throwing records the error and answers 500, so Twilio tries again. The recording stays on Twilio.
    if (!call) throw new Error("recording for an unknown call");
    const row = await db
      .insert(schema.callRecordings)
      .values({
        ownerId: call.ownerId,
        callId: call.id,
        numberId: call.numberId,
        duration: parseDuration(p.RecordingDuration),
        channels: p.RecordingChannels === "1" ? 1 : 2,
        twilioRecordingSid: recordingSid,
      })
      .onConflictDoNothing()
      .returning()
      .get();
    if (!row) return;
    c.executionCtx.waitUntil(storeAudio(c.env, db, callRecordingPipeline, row, c.executionCtx));
  });
  return c.body(null, 204);
});

twilioRecording.post("/notice", async (c) => {
  const p = await form(await c.req.parseBody());
  const db = c.get("db");
  // The whisper runs on the called party's leg. The call row is keyed by its parent (the browser's leg).
  const sid = p.ParentCallSid || p.CallSid;
  const call = sid ? await callForRecording(db, sid) : null;
  // An empty answer connects the call at once, so a missing row never blocks it.
  if (!call) return twimlResponse(response());
  return twimlResponse(response(noticeSay(await recordingSettings(db, call.ownerId, call.numberId))));
});
