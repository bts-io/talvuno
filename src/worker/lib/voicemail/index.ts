/**
 * The voicemail pipeline after Twilio has recorded a message.
 *
 *   1. The recording status callback (routes/twilio-voicemail.ts) inserts a `voicemails` row. From then on the
 *      message is never lost: the Twilio copy stays until our own copy is in R2.
 *   2. storeVoicemail downloads the audio, puts it in R2, deletes the Twilio copy, queues the transcription
 *      and tells the owner. A failed step is recorded on the row and repairVoicemails (cron) runs it again.
 *   3. The TRANSCRIBE queue consumer runs Whisper through AI Gateway and stores the transcript. It retries
 *      with backoff and marks the transcript failed after the last retry. The audio stays playable either way.
 *   4. pruneVoicemails (cron) deletes voicemail older than the owner's retention setting.
 */
import { and, eq, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import type { LivePush } from "../../../contracts";
import { DEFAULT_VOICEMAIL_RETENTION_DAYS } from "../../../contracts/voicemail";
import { createDb, type Db, schema } from "../../db";
import { findContactByNumber } from "../contacts";
import { notifyOwner } from "../hub";
import { TwilioApiError, TwilioNotConfiguredError, twilioRest } from "../twilio/rest";
import { isWithheld, partyLabel } from "../voice/call-rules";

const { voicemails, voicemailSettings } = schema;

export type VoicemailRow = typeof voicemails.$inferSelect;

export const TRANSCRIBE_MODEL = "@cf/openai/whisper-large-v3-turbo";
/** How long one download from Twilio may take. */
export const DOWNLOAD_TIMEOUT_MS = 15_000;
/** A two-minute message is well under 2 MB as MP3. Anything far larger is not a voicemail. */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
/** Download attempts before the cron gives up (one a quarter hour: about a day). The Twilio copy stays. */
export const MAX_STORE_ATTEMPTS = 96;
/** The cron leaves a fresh row alone, so it does not race the callback's own first attempt. */
export const STORE_RETRY_AFTER_MS = 2 * 60 * 1000;
/** A transcript still pending this long after the audio was stored lost its queue message: queue it again. */
export const TRANSCRIBE_STALE_MS = 2 * 60 * 60 * 1000;
/** Must match max_retries of the talvuno-transcribe consumer in wrangler.jsonc. */
export const TRANSCRIBE_MAX_RETRIES = 5;
/** Rows each cron job handles per run; the rest wait for the next run. */
export const VOICEMAIL_CRON_BATCH = 50;

export type TranscribeMessage = { voicemailId: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where a voicemail's audio lives in the RECORDINGS bucket. */
export const voicemailKey = (ownerId: string, callId: string, ext: string) =>
  `voicemail/${ownerId}/${callId}.${ext}`;

const EXT_BY_TYPE: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};

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

/** Base64 of `bytes`, built in slices so a large buffer never overflows the argument list. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const errorText = (err: unknown) => String(err instanceof Error ? err.message : err).slice(0, 500);

/** Deletes the Twilio copy of a stored voicemail. A recording Twilio no longer has counts as deleted. */
export async function deleteTwilioCopy(env: Env, db: Db, row: VoicemailRow): Promise<void> {
  if (row.twilioDeletedAt) return;
  try {
    await twilioRest(env).delete(`/Recordings/${encodeURIComponent(row.twilioRecordingSid)}.json`, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    if (!(err instanceof TwilioApiError && err.status === 404)) throw err;
  }
  await db.update(voicemails).set({ twilioDeletedAt: new Date() }).where(eq(voicemails.id, row.id));
}

async function enqueueTranscription(env: Env, voicemailId: string) {
  const message: TranscribeMessage = { voicemailId };
  await env.TRANSCRIBE.send(message);
}

/**
 * Downloads the recording into R2, deletes the Twilio copy, queues the transcription and tells the owner.
 * Never throws: a failure is recorded on the row (store_error, store_attempts) for the cron to retry, and the
 * Twilio copy is kept until our copy exists. Returns true once the audio is in R2.
 */
export async function storeVoicemail(
  env: Env,
  db: Db,
  row: VoicemailRow,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<boolean> {
  let stored: VoicemailRow | undefined;
  try {
    if (row.r2Key) return true;
    const res = await twilioRest(env).media(`/Recordings/${encodeURIComponent(row.twilioRecordingSid)}.mp3`, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() || "audio/mpeg";
    const ext = EXT_BY_TYPE[contentType];
    if (!ext) {
      await res.body?.cancel();
      throw new Error(`unexpected recording type ${contentType}`);
    }
    const audio = await res.arrayBuffer();
    if (audio.byteLength === 0) throw new Error("empty recording");
    if (audio.byteLength > MAX_AUDIO_BYTES)
      throw new Error(`recording too large (${audio.byteLength} bytes)`);
    const key = voicemailKey(row.ownerId, row.callId, ext);
    await env.RECORDINGS.put(key, audio, { httpMetadata: { contentType } });
    // Guarded on r2_key, so a cron run and the callback storing the same row only finish it once.
    stored = await db
      .update(voicemails)
      .set({
        r2Key: key,
        contentType,
        size: audio.byteLength,
        storeError: null,
        storeAttempts: sql`${voicemails.storeAttempts} + 1`,
      })
      .where(and(eq(voicemails.id, row.id), isNull(voicemails.r2Key)))
      .returning()
      .get();
  } catch (err) {
    if (err instanceof TwilioNotConfiguredError) return false;
    console.error("voicemail store failed", { voicemailId: row.id, error: errorText(err) });
    await db
      .update(voicemails)
      .set({ storeAttempts: sql`${voicemails.storeAttempts} + 1`, storeError: errorText(err) })
      .where(eq(voicemails.id, row.id))
      .catch(() => {});
    return false;
  }
  if (!stored) return true;

  // The audio is safe in R2 from here on. Each step below is retried by the cron when it fails.
  try {
    await deleteTwilioCopy(env, db, stored);
  } catch (err) {
    console.error("voicemail twilio delete failed", { voicemailId: stored.id, error: errorText(err) });
  }
  try {
    await enqueueTranscription(env, stored.id);
  } catch (err) {
    console.error("voicemail enqueue failed", { voicemailId: stored.id, error: errorText(err) });
  }
  await notifyOwner(
    env,
    stored.ownerId,
    {
      type: "voicemail",
      voicemailId: stored.id,
      callId: stored.callId,
      push: voicemailPush(stored, await callerLabel(db, stored)),
    },
    ctx,
  );
  return true;
}

/**
 * Transcribes one voicemail with Whisper through AI Gateway and stores the text. Throws on any failure so the
 * queue retries. A voicemail that is gone or already transcribed is skipped.
 */
export async function transcribeVoicemail(env: Env, voicemailId: string): Promise<"done" | "skipped"> {
  const db = createDb(env.DB);
  const row = await db.select().from(voicemails).where(eq(voicemails.id, voicemailId)).get();
  if (!row || row.transcriptStatus === "done") return "skipped";
  if (!row.r2Key) throw new Error("audio not stored yet");
  const object = await env.RECORDINGS.get(row.r2Key);
  if (!object) return "skipped";
  const audio = toBase64(new Uint8Array(await object.arrayBuffer()));
  const out = await env.AI.run(
    TRANSCRIBE_MODEL,
    { audio, task: "transcribe", vad_filter: true },
    { gateway: { id: env.AI_GATEWAY_ID ?? "default" } },
  );
  const text = (typeof out?.text === "string" ? out.text : "").trim();
  const updated = await db
    .update(voicemails)
    .set({ transcript: text, transcriptStatus: "done", transcriptError: null })
    .where(and(eq(voicemails.id, row.id), ne(voicemails.transcriptStatus, "done")))
    .returning()
    .get();
  if (!updated) return "skipped";
  await notifyOwner(env, updated.ownerId, {
    type: "voicemail",
    voicemailId: updated.id,
    callId: updated.callId,
    // The second notice only when there is something to read; it replaces the first (same tag).
    push:
      text && !updated.listenedAt ? voicemailPush(updated, await callerLabel(db, updated), text) : undefined,
  });
  return "done";
}

/** Delay before the next transcription attempt: 30 s, doubling, at most 15 minutes. */
export const transcribeRetryDelay = (attempts: number) => Math.min(900, 30 * 2 ** Math.max(0, attempts - 1));

const voicemailIdOf = (body: unknown) =>
  body && typeof body === "object" && typeof (body as TranscribeMessage).voicemailId === "string"
    ? (body as TranscribeMessage).voicemailId
    : null;

/** The TRANSCRIBE queue consumer. */
export async function handleTranscribeBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const db = createDb(env.DB);
  for (const msg of batch.messages) {
    const id = voicemailIdOf(msg.body);
    if (!id) {
      msg.ack();
      continue;
    }
    try {
      await transcribeVoicemail(env, id);
      msg.ack();
    } catch (err) {
      const last = msg.attempts > TRANSCRIBE_MAX_RETRIES;
      console.error("voicemail transcription failed", { voicemailId: id, attempt: msg.attempts, last });
      await db
        .update(voicemails)
        .set({ transcriptError: errorText(err), ...(last ? { transcriptStatus: "failed" as const } : {}) })
        .where(and(eq(voicemails.id, id), ne(voicemails.transcriptStatus, "done")))
        .catch(() => {});
      if (last) {
        msg.ack();
        const ownerId = await ownerOf(db, id);
        if (ownerId) await notifyOwner(env, ownerId, { type: "voicemail", voicemailId: id });
      } else msg.retry({ delaySeconds: transcribeRetryDelay(msg.attempts) });
    }
  }
}

async function ownerOf(db: Db, id: string) {
  const row = await db
    .select({ ownerId: voicemails.ownerId })
    .from(voicemails)
    .where(eq(voicemails.id, id))
    .get();
  return row?.ownerId ?? null;
}

/** Queues a failed transcription again. Returns false when the voicemail has no stored audio yet. */
export async function retryTranscription(env: Env, db: Db, row: VoicemailRow): Promise<boolean> {
  if (!row.r2Key) return false;
  if (row.transcriptStatus === "done") return true;
  await db
    .update(voicemails)
    .set({ transcriptStatus: "pending", transcriptError: null })
    .where(eq(voicemails.id, row.id));
  await enqueueTranscription(env, row.id);
  return true;
}

/** Deletes a voicemail everywhere: the Twilio copy (if still there), the R2 object, then the row. */
export async function deleteVoicemail(env: Env, db: Db, row: VoicemailRow): Promise<void> {
  if (!row.twilioDeletedAt) await deleteTwilioCopy(env, db, row);
  if (row.r2Key) await env.RECORDINGS.delete(row.r2Key);
  await db.delete(voicemails).where(and(eq(voicemails.id, row.id), eq(voicemails.ownerId, row.ownerId)));
}

/**
 * Cron: finishes what the callback could not. Downloads audio still on Twilio, deletes Twilio copies that
 * outlived their download, and queues transcriptions whose queue message was lost.
 */
export async function repairVoicemails(env: Env, ctx?: ExecutionContext, now = Date.now()): Promise<void> {
  const db = createDb(env.DB);
  const unstored = await db
    .select()
    .from(voicemails)
    .where(
      and(
        isNull(voicemails.r2Key),
        lt(voicemails.storeAttempts, MAX_STORE_ATTEMPTS),
        lt(voicemails.createdAt, new Date(now - STORE_RETRY_AFTER_MS)),
      ),
    )
    .limit(VOICEMAIL_CRON_BATCH);
  for (const row of unstored) await storeVoicemail(env, db, row, ctx);

  const undeleted = await db
    .select()
    .from(voicemails)
    .where(and(isNotNull(voicemails.r2Key), isNull(voicemails.twilioDeletedAt)))
    .limit(VOICEMAIL_CRON_BATCH);
  for (const row of undeleted) {
    try {
      await deleteTwilioCopy(env, db, row);
    } catch (err) {
      if (err instanceof TwilioNotConfiguredError) break;
      console.error("voicemail twilio delete failed", { voicemailId: row.id, error: errorText(err) });
    }
  }

  const stale = await db
    .select({ id: voicemails.id })
    .from(voicemails)
    .where(
      and(
        isNotNull(voicemails.r2Key),
        eq(voicemails.transcriptStatus, "pending"),
        lt(voicemails.createdAt, new Date(now - TRANSCRIBE_STALE_MS)),
        sql`${voicemails.createdAt} > ${now - 2 * DAY_MS}`,
      ),
    )
    .limit(VOICEMAIL_CRON_BATCH);
  for (const { id } of stale) await enqueueTranscription(env, id).catch(() => {});
}

/** The owner's retention in days (0 keeps voicemail forever). */
export async function retentionDays(db: Db, ownerId: string): Promise<number> {
  const row = await db
    .select({ days: voicemailSettings.retentionDays })
    .from(voicemailSettings)
    .where(eq(voicemailSettings.ownerId, ownerId))
    .get();
  return row?.days ?? DEFAULT_VOICEMAIL_RETENTION_DAYS;
}

/** Cron: deletes voicemail older than its owner's retention setting, from Twilio, R2 and D1. */
export async function pruneVoicemails(env: Env, _ctx?: ExecutionContext, now = Date.now()): Promise<void> {
  const db = createDb(env.DB);
  const days = sql<number>`coalesce(${voicemailSettings.retentionDays}, ${DEFAULT_VOICEMAIL_RETENTION_DAYS})`;
  const expired = await db
    .select({ vm: voicemails })
    .from(voicemails)
    .leftJoin(voicemailSettings, eq(voicemailSettings.ownerId, voicemails.ownerId))
    .where(and(sql`${days} > 0`, sql`${voicemails.createdAt} < ${now} - ${days} * ${DAY_MS}`))
    .limit(VOICEMAIL_CRON_BATCH);
  for (const { vm } of expired) {
    try {
      await deleteVoicemail(env, db, vm);
    } catch (err) {
      // The row stays until every copy is gone, so the next run tries again.
      console.error("voicemail prune failed", { voicemailId: vm.id, error: errorText(err) });
    }
  }
}
