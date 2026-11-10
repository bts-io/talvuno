/**
 * The voicemail pipeline after Twilio has recorded a message. The steps (store, transcribe, repair, prune)
 * are the shared audio pipeline in lib/recordings/store.ts. This file says what is particular to voicemail:
 * its table, its R2 key, and the notices it sends.
 *
 *   1. The recording status callback (routes/twilio-voicemail.ts) inserts a `voicemails` row.
 *   2. storeVoicemail stores the audio and tells the owner (a push, quiet during do not disturb or outside
 *      the number's hours).
 *   3. The TRANSCRIBE queue consumer (handleTranscribeBatch, for voicemail and call recordings) stores the
 *      transcript, and a second notice with its first line replaces the first one.
 *   4. pruneVoicemails (cron) deletes voicemail older than the owner's retention setting.
 */
import { eq } from "drizzle-orm";
import type { LivePush } from "../../../contracts";
import { type Db, schema } from "../../db";
import { onTranscriptReady } from "../ai/summary";
import { findContactByNumber } from "../contacts";
import { notifyOwner } from "../hub";
import {
  type AudioPipeline,
  deleteAudio,
  handleTranscribe,
  pruneAudio,
  repairAudio,
  retryTranscription as retryAudioTranscription,
  storeAudio,
} from "../recordings/store";
import { isWithheld, partyLabel } from "../voice/call-rules";
import { callRecordingPipeline } from "../voice/recording";
import { quietPushNow } from "../voice/routing";

export {
  retentionDays,
  STORE_RETRY_AFTER_MS,
  TRANSCRIBE_MAX_RETRIES,
  TRANSCRIBE_MODEL,
  type TranscribeMessage,
} from "../recordings/store";

const { voicemails } = schema;

export type VoicemailRow = typeof voicemails.$inferSelect;

/** A two-minute message is well under 2 MB as MP3. Anything far larger is not a voicemail. */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/** Where a voicemail's audio lives in the RECORDINGS bucket. */
export const voicemailKey = (ownerId: string, callId: string, ext: string) =>
  `voicemail/${ownerId}/${callId}.${ext}`;

/** Seconds as "0:42" for a notice. */
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** The first line of a transcript, for a notice. */
export const firstLine = (text: string) =>
  text
    .trim()
    .split(/\r?\n|(?<=[.!?])\s+/)[0]
    ?.trim() ?? "";

async function callerLabel(db: Db, row: VoicemailRow) {
  const contact = isWithheld(row.from) ? null : await findContactByNumber(db, row.ownerId, row.from);
  return partyLabel(row.from, contact?.displayName ?? null);
}

/**
 * Whether the notices for this voicemail stay quiet: do not disturb is on, or the number it came in on is
 * outside its business hours. The live event still reaches open screens.
 */
async function quietFor(db: Db, row: VoicemailRow) {
  const call = await db
    .select({ numberId: schema.calls.numberId })
    .from(schema.calls)
    .where(eq(schema.calls.id, row.callId))
    .get();
  return quietPushNow(db, row.ownerId, call?.numberId ?? null);
}

/** The voicemail notice. Tagged by call, so the transcript notice replaces the first one. */
export function voicemailPush(row: VoicemailRow, label: string, transcript?: string | null): LivePush {
  const line = transcript ? firstLine(transcript) : "";
  return {
    title: `New voicemail from ${label}`,
    body: line || (row.duration ? `Voicemail, ${clock(row.duration)}` : "Voicemail"),
    url: "/recents?filter=voicemail",
    tag: `voicemail-${row.callId}`,
  };
}

export const voicemailPipeline: AudioPipeline<VoicemailRow> = {
  kind: "voicemail",
  label: "voicemail",
  table: voicemails,
  maxBytes: MAX_AUDIO_BYTES,
  mediaPath: (row) => `/Recordings/${encodeURIComponent(row.twilioRecordingSid)}.mp3`,
  key: (row, ext) => voicemailKey(row.ownerId, row.callId, ext),
  async onStored(env, db, row, ctx) {
    await notifyOwner(
      env,
      row.ownerId,
      {
        type: "voicemail",
        voicemailId: row.id,
        callId: row.callId,
        push: (await quietFor(db, row)) ? undefined : voicemailPush(row, await callerLabel(db, row)),
      },
      ctx,
    );
  },
  async onTranscribed(env, db, row, text) {
    await onTranscriptReady(env, undefined, {
      kind: "voicemail",
      id: row.id,
      ownerId: row.ownerId,
      transcript: text,
    });
    await notifyOwner(env, row.ownerId, {
      type: "voicemail",
      voicemailId: row.id,
      callId: row.callId,
      // The second notice only when there is something to read; it replaces the first (same tag).
      push:
        text && !row.listenedAt && !(await quietFor(db, row))
          ? voicemailPush(row, await callerLabel(db, row), text)
          : undefined,
    });
  },
  async onTranscribeFailed(env, _db, ownerId, id) {
    await notifyOwner(env, ownerId, { type: "voicemail", voicemailId: id });
  },
};

/**
 * Downloads the recording into R2, deletes the Twilio copy, queues the transcription and tells the owner.
 * Never throws. Returns true once the audio is in R2.
 */
export const storeVoicemail = (
  env: Env,
  db: Db,
  row: VoicemailRow,
  ctx?: Pick<ExecutionContext, "waitUntil">,
) => storeAudio(env, db, voicemailPipeline, row, ctx);

/** The TRANSCRIBE queue consumer, for voicemail and call recordings alike. */
export const handleTranscribeBatch = (batch: MessageBatch<unknown>, env: Env) =>
  handleTranscribe(batch, env, {
    voicemail: voicemailPipeline as AudioPipeline,
    call: callRecordingPipeline as AudioPipeline,
  });

/** Queues a failed transcription again. Returns false when the voicemail has no stored audio yet. */
export const retryTranscription = (env: Env, db: Db, row: VoicemailRow) =>
  retryAudioTranscription(env, db, voicemailPipeline as AudioPipeline, row);

/** Deletes a voicemail everywhere: the Twilio copy (if still there), the R2 object, then the row. */
export const deleteVoicemail = (env: Env, db: Db, row: VoicemailRow) =>
  deleteAudio(env, db, voicemailPipeline as AudioPipeline, row);

/** Cron: finishes what the callback could not (download, Twilio delete, lost queue message). */
export const repairVoicemails = (env: Env, ctx?: ExecutionContext, now = Date.now()) =>
  repairAudio(env, voicemailPipeline as AudioPipeline, ctx, now);

/** Cron: deletes voicemail older than its owner's retention setting, from Twilio, R2 and D1. */
export const pruneVoicemails = (env: Env, _ctx?: ExecutionContext, now = Date.now()) =>
  pruneAudio(env, voicemailPipeline as AudioPipeline, now);
