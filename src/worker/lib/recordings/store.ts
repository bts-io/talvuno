/**
 * The one code path for recorded audio, shared by voicemail (lib/voicemail) and call recordings
 * (lib/voice/recording.ts). Each kind describes itself as an AudioPipeline: its table, where its audio goes in
 * R2, how to download it, and what to tell the owner. Everything else is the same for both:
 *
 *   1. A recording status callback inserts the row. From then on the audio is never lost: the Twilio copy
 *      stays until our own copy is in R2.
 *   2. storeAudio downloads the audio, puts it in R2, deletes the Twilio copy and queues the transcription.
 *      A failed step is recorded on the row and repairAudio (cron) runs it again.
 *   3. The TRANSCRIBE queue consumer runs Whisper through AI Gateway and stores the transcript. It retries
 *      with backoff and marks the transcript failed after the last retry. The audio stays playable either way.
 *   4. pruneAudio (cron) deletes audio older than the owner's retention setting (one setting for both kinds).
 *
 * The two tables share every column this file touches (same names, same types), so the pipeline reads and
 * writes either through the voicemails column set.
 */
import { and, eq, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { DEFAULT_VOICEMAIL_RETENTION_DAYS } from "../../../contracts/voicemail";
import { createDb, type Db, schema } from "../../db";
import { deleteSummary, isSummaryJob, runSummaryJob } from "../ai/summary";
import { TwilioApiError, TwilioNotConfiguredError, twilioRest } from "../twilio/rest";

export const TRANSCRIBE_MODEL = "@cf/openai/whisper-large-v3-turbo";
/** How long one download from Twilio may take. */
export const DOWNLOAD_TIMEOUT_MS = 15_000;
/** Download attempts before the cron gives up (one a quarter hour: about a day). The Twilio copy stays. */
export const MAX_STORE_ATTEMPTS = 96;
/** The cron leaves a fresh row alone, so it does not race the callback's own first attempt. */
export const STORE_RETRY_AFTER_MS = 2 * 60 * 1000;
/** A transcript still pending this long after the audio was stored lost its queue message: queue it again. */
export const TRANSCRIBE_STALE_MS = 2 * 60 * 60 * 1000;
/** Must match max_retries of the talvuno-transcribe consumer in wrangler.jsonc. */
export const TRANSCRIBE_MAX_RETRIES = 5;
/**
 * Largest audio sent to Whisper, in bytes. Workers AI documents no size limit for the model, so the bound
 * comes from the Worker's 128 MB memory. The audio is streamed from R2 into base64 (streamToBase64), so the
 * peak is the base64 pieces, their joined text and the request the binding builds from it: about 4 times
 * the file, 80 MB at this cap. 20 MB is the voicemail download cap and about 85 minutes of call audio at
 * Twilio's 32 kbps MP3, so a 45 minute call is transcribed. Larger audio is marked failed without calling
 * Whisper and stays playable.
 */
export const TRANSCRIBE_MAX_BYTES = 20 * 1024 * 1024;
/** The transcript error of audio over TRANSCRIBE_MAX_BYTES. */
export const TOO_LONG_TO_TRANSCRIBE = "audio too long to transcribe";
/** Rows each cron job handles per run, per kind. The rest wait for the next run. */
export const AUDIO_CRON_BATCH = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

export type AudioKind = "voicemail" | "call";

/** The TRANSCRIBE queue message. */
export type TranscribeMessage = { kind: AudioKind; id: string };

/** The columns every audio row has. */
export type AudioRow = typeof schema.voicemails.$inferSelect | typeof schema.callRecordings.$inferSelect;

export interface AudioPipeline<Row extends AudioRow = AudioRow> {
  kind: AudioKind;
  /** For log lines: "voicemail", "call recording". */
  label: string;
  table: typeof schema.voicemails | typeof schema.callRecordings;
  /** Largest download accepted, in bytes. */
  maxBytes: number;
  /** The account path of the audio download, for example "/Recordings/RE....mp3". */
  mediaPath(row: Row): string;
  /** The R2 key for this row's audio. */
  key(row: Row, ext: string): string;
  /** Runs once, right after the audio reached R2. */
  onStored?(env: Env, db: Db, row: Row, ctx?: Pick<ExecutionContext, "waitUntil">): Promise<void>;
  /** Runs once, right after the transcript was saved. */
  onTranscribed?(env: Env, db: Db, row: Row, text: string): Promise<void>;
  /** Runs when the last transcription attempt failed. */
  onTranscribeFailed?(env: Env, db: Db, ownerId: string, id: string): Promise<void>;
}

/** The shared column set, so one query works on either table. */
const cols = (p: AudioPipeline) => p.table as unknown as typeof schema.voicemails;

const EXT_BY_TYPE: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};

/** Bytes per base64 piece: a multiple of 3, so pieces join without padding in between. */
const BASE64_PIECE = 3 * 0x2000;

const pieceBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/**
 * Base64 of a byte stream, encoded as it arrives. Only the base64 pieces are kept, never the whole audio or
 * a binary string of it, so memory stays near the size of the base64 text.
 */
export async function streamToBase64(stream: ReadableStream<Uint8Array>): Promise<string> {
  const pieces: string[] = [];
  let carry = new Uint8Array(0);
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let chunk = value;
    if (carry.length) {
      chunk = new Uint8Array(carry.length + value.length);
      chunk.set(carry);
      chunk.set(value, carry.length);
    }
    const whole = chunk.length - (chunk.length % 3);
    for (let i = 0; i < whole; i += BASE64_PIECE)
      pieces.push(pieceBase64(chunk.subarray(i, Math.min(i + BASE64_PIECE, whole))));
    carry = chunk.slice(whole);
  }
  if (carry.length) pieces.push(pieceBase64(carry));
  return pieces.join("");
}

export const errorText = (err: unknown) => String(err instanceof Error ? err.message : err).slice(0, 500);

/** Deletes a recording from Twilio. A recording Twilio no longer has counts as deleted. */
export async function deleteTwilioRecording(env: Env, recordingSid: string): Promise<void> {
  try {
    await twilioRest(env).delete(`/Recordings/${encodeURIComponent(recordingSid)}.json`, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    if (!(err instanceof TwilioApiError && err.status === 404)) throw err;
  }
}

/** Deletes the Twilio copy of a stored row and marks it deleted. */
export async function deleteTwilioCopy(env: Env, db: Db, p: AudioPipeline, row: AudioRow): Promise<void> {
  if (row.twilioDeletedAt) return;
  await deleteTwilioRecording(env, row.twilioRecordingSid);
  const t = cols(p);
  await db.update(t).set({ twilioDeletedAt: new Date() }).where(eq(t.id, row.id));
}

export async function enqueueTranscription(env: Env, kind: AudioKind, id: string): Promise<void> {
  const message: TranscribeMessage = { kind, id };
  await env.TRANSCRIBE.send(message);
}

/**
 * Downloads the recording into R2, deletes the Twilio copy, queues the transcription and runs `onStored`.
 * Never throws: a failure is recorded on the row (store_error, store_attempts) for the cron to retry, and the
 * Twilio copy is kept until our copy exists. Returns true once the audio is in R2.
 */
export async function storeAudio<Row extends AudioRow>(
  env: Env,
  db: Db,
  p: AudioPipeline<Row>,
  row: Row,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<boolean> {
  const t = cols(p as AudioPipeline);
  let stored: Row | undefined;
  try {
    if (row.r2Key) return true;
    const res = await twilioRest(env).media(p.mediaPath(row), {
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
    if (audio.byteLength > p.maxBytes) throw new Error(`recording too large (${audio.byteLength} bytes)`);
    const key = p.key(row, ext);
    await env.RECORDINGS.put(key, audio, { httpMetadata: { contentType } });
    // Guarded on r2_key, so a cron run and the callback storing the same row only finish it once.
    stored = (await db
      .update(t)
      .set({
        r2Key: key,
        contentType,
        size: audio.byteLength,
        storeError: null,
        storeAttempts: sql`${t.storeAttempts} + 1`,
      })
      .where(and(eq(t.id, row.id), isNull(t.r2Key)))
      .returning()
      .get()) as Row | undefined;
  } catch (err) {
    if (err instanceof TwilioNotConfiguredError) return false;
    console.error(`${p.label} store failed`, { id: row.id, error: errorText(err) });
    await db
      .update(t)
      .set({ storeAttempts: sql`${t.storeAttempts} + 1`, storeError: errorText(err) })
      .where(eq(t.id, row.id))
      .catch(() => {});
    return false;
  }
  if (!stored) return true;

  // The audio is safe in R2 from here on. Each step below is retried by the cron when it fails.
  try {
    await deleteTwilioCopy(env, db, p as AudioPipeline, stored);
  } catch (err) {
    console.error(`${p.label} twilio delete failed`, { id: stored.id, error: errorText(err) });
  }
  try {
    await enqueueTranscription(env, p.kind, stored.id);
  } catch (err) {
    console.error(`${p.label} enqueue failed`, { id: stored.id, error: errorText(err) });
  }
  await p.onStored?.(env, db, stored, ctx);
  return true;
}

/**
 * Transcribes one row with Whisper through AI Gateway and stores the text. Throws on any failure so the
 * queue retries. A row that is gone or already transcribed is skipped. Audio over TRANSCRIBE_MAX_BYTES is
 * marked failed at once without calling Whisper, since no retry could succeed.
 *
 * Call recordings have both sides on separate channels. Whisper takes one audio file and mixes it down, so
 * the transcript is of the mixed call, with no speaker labels: splitting the channels would mean decoding
 * and re-encoding the MP3 in the Worker, and Twilio offers no per-channel download.
 */
export async function transcribeAudio<Row extends AudioRow>(
  env: Env,
  p: AudioPipeline<Row>,
  id: string,
): Promise<"done" | "skipped" | "failed"> {
  const db = createDb(env.DB);
  const t = cols(p as AudioPipeline);
  const row = await db.select().from(t).where(eq(t.id, id)).get();
  if (!row || row.transcriptStatus === "done") return "skipped";
  if (!row.r2Key) throw new Error("audio not stored yet");
  // The size comes from R2's metadata, so audio too large to transcribe is never read into memory.
  const head = await env.RECORDINGS.head(row.r2Key);
  if (!head) return "skipped";
  if (head.size > TRANSCRIBE_MAX_BYTES) {
    const failed = await db
      .update(t)
      .set({ transcriptStatus: "failed", transcriptError: TOO_LONG_TO_TRANSCRIBE })
      .where(and(eq(t.id, row.id), ne(t.transcriptStatus, "done")))
      .returning({ ownerId: t.ownerId })
      .get();
    if (failed) await p.onTranscribeFailed?.(env, db, failed.ownerId, row.id);
    return "failed";
  }
  const object = await env.RECORDINGS.get(row.r2Key);
  if (!object) return "skipped";
  const audio = await streamToBase64(object.body);
  const out = await env.AI.run(
    TRANSCRIBE_MODEL,
    { audio, task: "transcribe", vad_filter: true },
    { gateway: { id: env.AI_GATEWAY_ID ?? "default" } },
  );
  const text = (typeof out?.text === "string" ? out.text : "").trim();
  const updated = (await db
    .update(t)
    .set({ transcript: text, transcriptStatus: "done", transcriptError: null })
    .where(and(eq(t.id, row.id), ne(t.transcriptStatus, "done")))
    .returning()
    .get()) as Row | undefined;
  if (!updated) return "skipped";
  await p.onTranscribed?.(env, db, updated, text);
  return "done";
}

/** Delay before the next transcription attempt: 30 s, doubling, at most 15 minutes. */
export const transcribeRetryDelay = (attempts: number) => Math.min(900, 30 * 2 ** Math.max(0, attempts - 1));

/**
 * Reads a queue message. `{ kind, id }` is the current shape. `{ voicemailId }` is the shape before call
 * recordings existed, still accepted for messages queued before an upgrade.
 */
export function parseTranscribeMessage(body: unknown): TranscribeMessage | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if ((b.kind === "voicemail" || b.kind === "call") && typeof b.id === "string")
    return { kind: b.kind, id: b.id };
  if (typeof b.voicemailId === "string") return { kind: "voicemail", id: b.voicemailId };
  return null;
}

/** The TRANSCRIBE queue consumer, for every kind in `pipelines`. */
export async function handleTranscribe(
  batch: MessageBatch<unknown>,
  env: Env,
  pipelines: Record<AudioKind, AudioPipeline>,
): Promise<void> {
  const db = createDb(env.DB);
  for (const msg of batch.messages) {
    // Summary jobs share this queue (lib/ai/summary.ts). They never throw and are never retried.
    if (isSummaryJob(msg.body)) {
      await runSummaryJob(env, msg.body);
      msg.ack();
      continue;
    }
    const parsed = parseTranscribeMessage(msg.body);
    if (!parsed) {
      msg.ack();
      continue;
    }
    const p = pipelines[parsed.kind];
    const t = cols(p);
    const { id } = parsed;
    try {
      await transcribeAudio(env, p, id);
      msg.ack();
    } catch (err) {
      const last = msg.attempts > TRANSCRIBE_MAX_RETRIES;
      console.error(`${p.label} transcription failed`, { id, attempt: msg.attempts, last });
      await db
        .update(t)
        .set({ transcriptError: errorText(err), ...(last ? { transcriptStatus: "failed" as const } : {}) })
        .where(and(eq(t.id, id), ne(t.transcriptStatus, "done")))
        .catch(() => {});
      if (last) {
        msg.ack();
        const owner = await db.select({ ownerId: t.ownerId }).from(t).where(eq(t.id, id)).get();
        if (owner) await p.onTranscribeFailed?.(env, db, owner.ownerId, id);
      } else msg.retry({ delaySeconds: transcribeRetryDelay(msg.attempts) });
    }
  }
}

/** Queues a failed transcription again. Returns false when the row has no stored audio yet. */
export async function retryTranscription(
  env: Env,
  db: Db,
  p: AudioPipeline,
  row: AudioRow,
): Promise<boolean> {
  if (!row.r2Key) return false;
  if (row.transcriptStatus === "done") return true;
  const t = cols(p);
  await db.update(t).set({ transcriptStatus: "pending", transcriptError: null }).where(eq(t.id, row.id));
  await enqueueTranscription(env, p.kind, row.id);
  return true;
}

/**
 * Deletes a row's audio everywhere: the Twilio copy (if still there), the R2 object, its AI summary, then the
 * row. Delete and prune both come here, for voicemail and call recordings alike.
 */
export async function deleteAudio(env: Env, db: Db, p: AudioPipeline, row: AudioRow): Promise<void> {
  if (!row.twilioDeletedAt) await deleteTwilioCopy(env, db, p, row);
  if (row.r2Key) await env.RECORDINGS.delete(row.r2Key);
  await deleteSummary(db, row.ownerId, p.kind, row.id);
  const t = cols(p);
  await db.delete(t).where(and(eq(t.id, row.id), eq(t.ownerId, row.ownerId)));
}

/**
 * Cron: finishes what the callback could not. Downloads audio still on Twilio, deletes Twilio copies that
 * outlived their download, and queues transcriptions whose queue message was lost.
 */
export async function repairAudio(
  env: Env,
  p: AudioPipeline,
  ctx?: ExecutionContext,
  now = Date.now(),
): Promise<void> {
  const db = createDb(env.DB);
  const t = cols(p);
  const unstored = await db
    .select()
    .from(t)
    .where(
      and(
        isNull(t.r2Key),
        lt(t.storeAttempts, MAX_STORE_ATTEMPTS),
        lt(t.createdAt, new Date(now - STORE_RETRY_AFTER_MS)),
      ),
    )
    .limit(AUDIO_CRON_BATCH);
  for (const row of unstored) await storeAudio(env, db, p, row, ctx);

  const undeleted = await db
    .select()
    .from(t)
    .where(and(isNotNull(t.r2Key), isNull(t.twilioDeletedAt)))
    .limit(AUDIO_CRON_BATCH);
  for (const row of undeleted) {
    try {
      await deleteTwilioCopy(env, db, p, row);
    } catch (err) {
      if (err instanceof TwilioNotConfiguredError) break;
      console.error(`${p.label} twilio delete failed`, { id: row.id, error: errorText(err) });
    }
  }

  const stale = await db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        isNotNull(t.r2Key),
        eq(t.transcriptStatus, "pending"),
        lt(t.createdAt, new Date(now - TRANSCRIBE_STALE_MS)),
        sql`${t.createdAt} > ${now - 2 * DAY_MS}`,
      ),
    )
    .limit(AUDIO_CRON_BATCH);
  for (const { id } of stale) await enqueueTranscription(env, p.kind, id).catch(() => {});
}

/** The owner's retention in days (0 keeps recordings forever). One setting for voicemail and calls. */
export async function retentionDays(db: Db, ownerId: string): Promise<number> {
  const row = await db
    .select({ days: schema.voicemailSettings.retentionDays })
    .from(schema.voicemailSettings)
    .where(eq(schema.voicemailSettings.ownerId, ownerId))
    .get();
  return row?.days ?? DEFAULT_VOICEMAIL_RETENTION_DAYS;
}

/** Cron: deletes audio older than its owner's retention setting, from Twilio, R2 and D1. */
export async function pruneAudio(env: Env, p: AudioPipeline, now = Date.now()): Promise<void> {
  const db = createDb(env.DB);
  const t = cols(p);
  const settings = schema.voicemailSettings;
  const days = sql<number>`coalesce(${settings.retentionDays}, ${DEFAULT_VOICEMAIL_RETENTION_DAYS})`;
  const expired = await db
    .select({ row: t })
    .from(t)
    .leftJoin(settings, eq(settings.ownerId, t.ownerId))
    .where(and(sql`${days} > 0`, sql`${t.createdAt} < ${now} - ${days} * ${DAY_MS}`))
    .limit(AUDIO_CRON_BATCH);
  for (const { row } of expired) {
    try {
      await deleteAudio(env, db, p, row);
    } catch (err) {
      // The row stays until every copy is gone, so the next run tries again.
      console.error(`${p.label} prune failed`, { id: row.id, error: errorText(err) });
    }
  }
}
