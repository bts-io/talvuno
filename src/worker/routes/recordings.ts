/**
 * Call recordings, mounted at /api behind the owner session like every /api route. Everything is the
 * signed-in owner's own: another owner's call, recording or number reads as not found.
 *
 *   GET    /calls/:id/recordings              the recordings of one call, oldest first
 *   GET    /recordings/:id/audio              the audio from R2, with Range support, never cached
 *   POST   /recordings/:id/transcribe         queues a failed transcript again
 *   DELETE /recordings/:id                    deletes the audio everywhere and the row
 *   GET    /recordings/live?callSid=          whether the live call on this leg is being recorded
 *   POST   /recordings/live                   { callSid, action } starts, pauses or resumes it. A new
 *                                             recording is refused (409 recording_notice_on) while the
 *                                             number's notice is on
 *   GET    /recordings/settings               the recording switches of each of the owner's numbers
 *   PUT    /recordings/settings/:numberId     sets them for one number
 */
import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { idSchema } from "../../contracts";
import {
  type CallRecording,
  type CallRecordingList,
  type LiveRecordingState,
  liveRecordingActionSchema,
  liveRecordingQuerySchema,
  type NumberRecording,
  type NumberRecordingList,
  numberRecordingUpdateSchema,
} from "../../contracts/recording";
import { type Db, schema } from "../db";
import { summariesEnabled } from "../lib/ai/summary";
import { ApiError } from "../lib/errors";
import { notifyOwner } from "../lib/hub";
import { type AudioPipeline, deleteAudio, retryTranscription } from "../lib/recordings/store";
import { TwilioApiError, TwilioNotConfiguredError } from "../lib/twilio/rest";
import { validationHook } from "../lib/validation";
import { voiceNumbers } from "../lib/voice/numbers";
import {
  type CallRecordingRow,
  callRecordingPipeline,
  liveRecording,
  liveRecordingState,
  ownLiveCall,
  ownRecording,
  RecordingNoticeOnError,
  recordingLegs,
  recordingSettings,
  recordingsOfCall,
} from "../lib/voice/recording";
import type { AppEnv } from "../types";
import { audioResponse } from "./voicemails";

const pipeline = callRecordingPipeline as AudioPipeline;

export const recordingsRouter = new Hono<AppEnv>();

type SummaryRow = typeof schema.aiSummaries.$inferSelect;

const toEntry = (r: CallRecordingRow, ai: SummaryRow | null): CallRecording => ({
  id: r.id,
  callId: r.callId,
  duration: r.duration,
  channels: r.channels === 1 ? 1 : 2,
  audioReady: Boolean(r.r2Key),
  transcript: r.transcript,
  transcriptStatus: r.transcriptStatus,
  aiSummary:
    ai?.summary != null
      ? { summary: ai.summary, actionItems: ai.actionItems ?? [], oneLiner: ai.oneLiner }
      : null,
  createdAt: r.createdAt.getTime(),
});

/**
 * The finished AI summaries of these recordings by recording id. With summaries off none are returned,
 * including ones made while they were on, the same as for voicemail.
 */
async function summariesOf(db: Db, ownerId: string, ids: string[]): Promise<Map<string, SummaryRow>> {
  if (!ids.length || !(await summariesEnabled(db, ownerId))) return new Map();
  const { aiSummaries } = schema;
  const rows = await db
    .select()
    .from(aiSummaries)
    .where(
      and(
        eq(aiSummaries.ownerId, ownerId),
        eq(aiSummaries.sourceKind, "call"),
        inArray(aiSummaries.sourceId, ids),
        inArray(aiSummaries.status, ["done", "empty"]),
      ),
    );
  return new Map(rows.map((r) => [r.sourceId, r]));
}

recordingsRouter.get(
  "/calls/:id/recordings",
  zValidator("param", z.object({ id: idSchema }), validationHook),
  async (c) => {
    const db = c.get("db");
    const ownerId = c.get("user")!.id;
    const { id } = c.req.valid("param");
    c.header("cache-control", "no-store");
    const call = await db
      .select({ id: schema.calls.id })
      .from(schema.calls)
      .where(and(eq(schema.calls.id, id), eq(schema.calls.ownerId, ownerId)))
      .get();
    if (!call) throw new ApiError(404, "not_found", "Call not found");
    const recordings = await recordingsOfCall(db, ownerId, id);
    const summaries = await summariesOf(
      db,
      ownerId,
      recordings.map((r) => r.id),
    );
    const body: CallRecordingList = {
      items: recordings.map((r) => toEntry(r, summaries.get(r.id) ?? null)),
    };
    return c.json(body);
  },
);

async function own(c: Context<AppEnv>) {
  const row = await ownRecording(c.get("db"), c.get("user")!.id, c.req.param("id") ?? "");
  if (!row) throw new ApiError(404, "not_found", "Recording not found");
  return row;
}

/** Twilio refused or could not be reached: the call screen shows a short error and keeps its state. */
function twilioFailure(err: unknown): never {
  if (err instanceof TwilioNotConfiguredError)
    throw new ApiError(503, "not_configured", "Twilio is not configured");
  if (err instanceof TwilioApiError) {
    console.warn("live recording refused", { status: err.status, code: err.code });
    throw new ApiError(502, "twilio_error", "The recording could not be changed. Try again.");
  }
  if (err instanceof RecordingNoticeOnError)
    throw new ApiError(
      409,
      "recording_notice_on",
      "Recording cannot start mid-call while the recording notice is on. Turn on recording for the number so callers hear the notice first.",
    );
  throw err;
}

/** The owner's live call on this leg, or 404. */
async function liveCall(c: Context<AppEnv>, callSid: string) {
  const call = await ownLiveCall(c.get("db"), c.get("user")!.id, callSid);
  if (!call) throw new ApiError(404, "not_found", "Call not found");
  return { call, legs: recordingLegs(call, callSid) };
}

recordingsRouter.get(
  "/recordings/live",
  zValidator("query", liveRecordingQuerySchema, validationHook),
  async (c) => {
    c.header("cache-control", "no-store");
    const { legs } = await liveCall(c, c.req.valid("query").callSid);
    try {
      const body: LiveRecordingState = { state: await liveRecordingState(c.env, legs) };
      return c.json(body);
    } catch (err) {
      twilioFailure(err);
    }
  },
);

recordingsRouter.post(
  "/recordings/live",
  zValidator("json", liveRecordingActionSchema, validationHook),
  async (c) => {
    const { callSid, action } = c.req.valid("json");
    const { call, legs } = await liveCall(c, callSid);
    const settings = await recordingSettings(c.get("db"), call.ownerId, call.numberId);
    try {
      const body: LiveRecordingState = {
        state: await liveRecording(c.env, legs, action, { noticeOn: settings.playNotice }),
      };
      return c.json(body);
    } catch (err) {
      twilioFailure(err);
    }
  },
);

recordingsRouter.get("/recordings/settings", async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  c.header("cache-control", "no-store");
  const numbers = await voiceNumbers(db, ownerId);
  const items: NumberRecording[] = [];
  for (const n of numbers) items.push({ numberId: n.id, ...(await recordingSettings(db, ownerId, n.id)) });
  const body: NumberRecordingList = { items };
  return c.json(body);
});

recordingsRouter.put(
  "/recordings/settings/:numberId",
  zValidator("param", z.object({ numberId: idSchema }), validationHook),
  zValidator("json", numberRecordingUpdateSchema.strict(), validationHook),
  async (c) => {
    const db = c.get("db");
    const ownerId = c.get("user")!.id;
    const { numberId } = c.req.valid("param");
    const number = (await voiceNumbers(db, ownerId)).find((n) => n.id === numberId);
    if (!number) throw new ApiError(404, "not_found", "Number not found");
    const input = c.req.valid("json");
    const set = {
      recordCalls: input.recordCalls,
      playNotice: input.playNotice,
      noticeText: input.noticeText || null,
    };
    await db
      .insert(schema.numberRecording)
      .values({ ownerId, numberId, ...set })
      .onConflictDoUpdate({
        target: schema.numberRecording.numberId,
        set: { ...set, updatedAt: new Date() },
      });
    const body: NumberRecording = { numberId, ...set };
    return c.json(body);
  },
);

recordingsRouter.get("/recordings/:id/audio", async (c) => {
  const row = await own(c);
  return audioResponse(c, row.r2Key, row.contentType);
});

recordingsRouter.post("/recordings/:id/transcribe", async (c) => {
  const row = await own(c);
  if (row.transcriptStatus !== "failed")
    throw new ApiError(409, "not_failed", "Only a failed transcript can be retried");
  if (!(await retryTranscription(c.env, c.get("db"), pipeline, row)))
    throw new ApiError(409, "not_ready", "The audio is not stored yet");
  return c.body(null, 202);
});

recordingsRouter.delete("/recordings/:id", async (c) => {
  const row = await own(c);
  try {
    await deleteAudio(c.env, c.get("db"), pipeline, row);
  } catch (err) {
    console.error("call recording delete failed", { id: row.id, error: String(err) });
    throw new ApiError(502, "delete_failed", "The recording could not be deleted. Try again.");
  }
  await notifyOwner(
    c.env,
    row.ownerId,
    { type: "recording", callId: row.callId, recordingId: row.id },
    c.executionCtx,
  );
  return c.body(null, 204);
});
