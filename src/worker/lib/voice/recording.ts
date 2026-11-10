/**
 * Call recording. Off unless the owner switches it on for a number, or starts it from the call screen.
 *
 *   per number   the outbound <Dial> and the answering <Dial><Queue> get record="record-from-answer-dual", so
 *                both sides are recorded on separate channels from the moment the call is bridged. With the
 *                notice switched on, the other party hears it first: on an outbound call through the
 *                <Number url> whisper (played to the called party after they answer, before the bridge), on
 *                an inbound call as a <Say> before <Enqueue>.
 *   per call     the call screen starts, pauses or resumes a recording on the owner's own leg through
 *                Twilio's call Recordings resource (liveRecording below). Twilio has no simple way to speak
 *                into a bridged <Dial>, so while a number's notice is on a new recording cannot start mid-call:
 *                the owner turns on recording for the number instead, and callers hear the notice first.
 *
 * The notice follows its own switch: whenever it is on, every call on the number hears it (the outbound
 * whisper, the <Say> before <Enqueue>), whether or not the call is recorded from the start.
 *
 * Every recording reports to /api/twilio/voice/recording (routes/twilio-recording.ts), which records a
 * call_recordings row. From there the audio goes through the shared audio pipeline (lib/recordings/store.ts)
 * like a voicemail: into R2, deleted from Twilio, transcribed, pruned with the voicemail retention.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import type { LiveRecordingState } from "../../../contracts/recording";
import en from "../../../shared/locales/en.json";
import { type Db, schema } from "../../db";
import { onTranscriptReady } from "../ai/summary";
import { notifyOwner } from "../hub";
import { type AudioPipeline, DOWNLOAD_TIMEOUT_MS, pruneAudio, repairAudio } from "../recordings/store";
import { twilioRest } from "../twilio/rest";
import type { CallRow } from "./call-rules";
import { el, text } from "./twiml";

const { callRecordings, numberRecording } = schema;

export type CallRecordingRow = typeof callRecordings.$inferSelect;

export const DEFAULT_RECORDING_NOTICE = en.recording.defaultNotice;

/**
 * A two-hour call (the call time limit) is about 29 MB as Twilio's 32 kbps MP3. Audio over the transcription
 * cap (TRANSCRIBE_MAX_BYTES in lib/recordings/store.ts) stays playable with a failed transcript.
 */
export const MAX_CALL_AUDIO_BYTES = 32 * 1024 * 1024;

/** Where a call recording's audio lives in the RECORDINGS bucket. */
export const callRecordingKey = (ownerId: string, callId: string, recordingSid: string, ext = "mp3") =>
  `recording/${ownerId}/${callId}/${recordingSid}.${ext}`;

const voiceUrl = (env: Env, path: string) => `${new URL(env.PUBLIC_URL).origin}/api/twilio/voice${path}`;

/** Where every recording of a call reports. */
export const recordingCallbackUrl = (env: Env) => voiceUrl(env, "/recording");
/** The outbound whisper that speaks the notice to the called party. */
export const recordingNoticeUrl = (env: Env) => voiceUrl(env, "/recording/notice");

export type RecordingSettings = { recordCalls: boolean; playNotice: boolean; noticeText: string | null };

const OFF: RecordingSettings = { recordCalls: false, playNotice: false, noticeText: null };

/** A number's recording switches. No row, or no number, means off. */
export async function recordingSettings(
  db: Db,
  ownerId: string,
  numberId: string | null,
): Promise<RecordingSettings> {
  if (!numberId) return OFF;
  const row = await db
    .select()
    .from(numberRecording)
    .where(and(eq(numberRecording.ownerId, ownerId), eq(numberRecording.numberId, numberId)))
    .get();
  return row ? { recordCalls: row.recordCalls, playNotice: row.playNotice, noticeText: row.noticeText } : OFF;
}

/** The notice to speak for these settings, or null when the notice is off. Recording does not matter. */
export function recordingNotice(s: RecordingSettings): string | null {
  if (!s.playNotice) return null;
  return s.noticeText?.trim() || DEFAULT_RECORDING_NOTICE;
}

/** The <Say> of the notice, or an empty string. */
export const noticeSay = (s: RecordingSettings) => {
  const notice = recordingNotice(s);
  return notice ? el("Say", {}, text(notice)) : "";
};

/** The recording attributes of a <Dial>: dual channel from answer when on, nothing when off. */
export function dialRecordingAttrs(env: Env, s: RecordingSettings): Record<string, string> {
  if (!s.recordCalls) return {};
  return {
    record: "record-from-answer-dual",
    recordingStatusCallback: recordingCallbackUrl(env),
    recordingStatusCallbackMethod: "POST",
    recordingStatusCallbackEvent: "completed",
  };
}

/** The <Number url> whisper attributes for an outbound call, when the notice plays. */
export function whisperAttrs(env: Env, s: RecordingSettings): Record<string, string> {
  return recordingNotice(s) ? { url: recordingNoticeUrl(env), method: "POST" } : {};
}

/**
 * The call row a recording or the call screen names by CallSid. Twilio reports a <Dial> recording under the
 * parent leg (the browser's leg of an outbound call, the caller's leg of an inbound call). A recording
 * started from the call screen runs on the owner's own leg, which for an inbound call is the answering leg.
 */
export async function callForRecording(db: Db, callSid: string): Promise<CallRow | null> {
  return (
    (await db
      .select()
      .from(schema.calls)
      .where(or(eq(schema.calls.twilioCallSid, callSid), eq(schema.calls.answerCallSid, callSid)))
      .get()) ?? null
  );
}

/**
 * The owner's live call the call screen names: their own leg's CallSid, on a call of theirs that has not
 * ended. Anything else is null.
 */
export async function ownLiveCall(db: Db, ownerId: string, callSid: string): Promise<CallRow | null> {
  return (
    (await db
      .select()
      .from(schema.calls)
      .where(
        and(
          eq(schema.calls.ownerId, ownerId),
          isNull(schema.calls.endedAt),
          or(
            and(eq(schema.calls.direction, "outbound"), eq(schema.calls.twilioCallSid, callSid)),
            and(eq(schema.calls.direction, "inbound"), eq(schema.calls.answerCallSid, callSid)),
          ),
        ),
      )
      .get()) ?? null
  );
}

type TwilioRecording = { sid: string; status: string; date_created?: string };
type RecordingPage = { recordings?: TwilioRecording[] };

const recordingsPath = (callSid: string) => `/Calls/${encodeURIComponent(callSid)}/Recordings.json`;

/**
 * The recording running or paused right now on any of `legs`, and the leg it runs on. A <Dial> recording of
 * an inbound call is listed under the caller's leg, one started from the call screen under the owner's leg.
 */
async function currentRecording(
  env: Env,
  legs: readonly string[],
): Promise<{ callSid: string; rec: TwilioRecording } | null> {
  for (const callSid of legs) {
    const page = await twilioRest(env).get<RecordingPage>(recordingsPath(callSid), undefined, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    const rec = page.recordings?.find((r) => r.status === "in-progress" || r.status === "paused");
    if (rec) return { callSid, rec };
  }
  return null;
}

const stateOf = (r: TwilioRecording | null | undefined): LiveRecordingState["state"] =>
  r?.status === "in-progress" ? "recording" : r?.status === "paused" ? "paused" : "off";

/** The legs of a live call that can carry its recording. The owner's own leg comes first. */
export const recordingLegs = (row: CallRow, ownLeg: string) =>
  [ownLeg, row.twilioCallSid].filter((sid, i, all) => sid && all.indexOf(sid) === i);

/** Whether the call is being recorded right now, as Twilio sees it. */
export async function liveRecordingState(
  env: Env,
  legs: readonly string[],
): Promise<LiveRecordingState["state"]> {
  return stateOf((await currentRecording(env, legs))?.rec);
}

/** A new recording mid-call was refused because the number's notice is on. */
export class RecordingNoticeOnError extends Error {
  constructor() {
    super("A recording cannot start mid-call while the recording notice is on");
  }
}

/**
 * Starts, pauses or resumes the recording of a live call. `legs[0]` is the owner's own leg, where a new
 * recording starts. Start does nothing when a recording already runs (and resumes a paused one), so a second
 * tap never makes a second recording. The caller has already checked the call is the owner's live call.
 *
 * With `noticeOn`, a start that would make a new recording throws RecordingNoticeOnError: the other party
 * would be recorded without hearing the notice. Pausing and resuming a recording that already runs (one the
 * notice announced) still work.
 */
export async function liveRecording(
  env: Env,
  legs: readonly string[],
  action: "start" | "pause" | "resume",
  opts: { noticeOn: boolean },
): Promise<LiveRecordingState["state"]> {
  const rest = twilioRest(env);
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const current = await currentRecording(env, legs);
  const update = (status: "paused" | "in-progress") =>
    rest.post<TwilioRecording>(
      `/Calls/${encodeURIComponent(current!.callSid)}/Recordings/${encodeURIComponent(current!.rec.sid)}.json`,
      status === "paused" ? { Status: status, PauseBehavior: "skip" } : { Status: status },
      { signal },
    );
  const status = current?.rec.status;
  if (action === "pause")
    return status === "in-progress" ? stateOf(await update("paused")) : stateOf(current?.rec);
  if (status === "paused") return stateOf(await update("in-progress"));
  if (current || action === "resume" || !legs[0]) return stateOf(current?.rec);
  if (opts.noticeOn) throw new RecordingNoticeOnError();
  const started = await rest.post<TwilioRecording>(
    recordingsPath(legs[0]),
    {
      RecordingChannels: "dual",
      RecordingStatusCallback: recordingCallbackUrl(env),
      RecordingStatusCallbackMethod: "POST",
      RecordingStatusCallbackEvent: "completed",
    },
    { signal },
  );
  return stateOf(started);
}

const notifyRecording = (env: Env, row: CallRecordingRow, ctx?: Pick<ExecutionContext, "waitUntil">) =>
  notifyOwner(env, row.ownerId, { type: "recording", callId: row.callId, recordingId: row.id }, ctx);

export const callRecordingPipeline: AudioPipeline<CallRecordingRow> = {
  kind: "call",
  label: "call recording",
  table: callRecordings,
  maxBytes: MAX_CALL_AUDIO_BYTES,
  // Both channels: without RequestedChannels Twilio may answer with the format it recorded, which is fine,
  // but asking keeps a dual recording dual.
  mediaPath: (row) =>
    `/Recordings/${encodeURIComponent(row.twilioRecordingSid)}.mp3?RequestedChannels=${row.channels}`,
  key: (row, ext) => callRecordingKey(row.ownerId, row.callId, row.twilioRecordingSid, ext),
  async onStored(env, _db, row, ctx) {
    await notifyRecording(env, row, ctx);
  },
  async onTranscribed(env, _db, row, text) {
    await onTranscriptReady(env, undefined, {
      kind: "call",
      id: row.id,
      ownerId: row.ownerId,
      transcript: text,
    });
    await notifyRecording(env, row);
  },
  async onTranscribeFailed(env, db, ownerId, id) {
    const row = await db.select().from(callRecordings).where(eq(callRecordings.id, id)).get();
    if (row && row.ownerId === ownerId) await notifyRecording(env, row);
  },
};

/** The recordings of one of the owner's calls, oldest first. */
export async function recordingsOfCall(db: Db, ownerId: string, callId: string) {
  return db
    .select()
    .from(callRecordings)
    .where(and(eq(callRecordings.ownerId, ownerId), eq(callRecordings.callId, callId)))
    .orderBy(callRecordings.createdAt, callRecordings.id);
}

/** The owner's recording with this id, or null. */
export async function ownRecording(db: Db, ownerId: string, id: string) {
  return (
    (await db
      .select()
      .from(callRecordings)
      .where(and(eq(callRecordings.id, id), eq(callRecordings.ownerId, ownerId)))
      .get()) ?? null
  );
}

/** Cron: finishes what the recording callback could not (download, Twilio delete, lost queue message). */
export const repairCallRecordings = (env: Env, ctx?: ExecutionContext, now = Date.now()) =>
  repairAudio(env, callRecordingPipeline as AudioPipeline, ctx, now);

/** Cron: deletes call recordings older than the owner's retention (the voicemail setting). */
export const pruneCallRecordings = (env: Env, _ctx?: ExecutionContext, now = Date.now()) =>
  pruneAudio(env, callRecordingPipeline as AudioPipeline, now);
