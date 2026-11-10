/**
 * AI summaries of transcripts: a short summary, up to three action items and, for voicemail, what the caller
 * wanted in one line.
 *
 *   1. Whoever saves a transcript calls onTranscriptReady once. It checks the owner's setting, claims the
 *      `ai_summaries` row (unique per transcript, so a repeated call does nothing) and puts a summary job on
 *      the TRANSCRIBE queue. A transcript without a real message gets "No message" without the model.
 *   2. The queue consumer hands summary jobs to runSummaryJob, which asks the model through AI Gateway with a
 *      JSON schema, checks the reply (summary-prompt.ts) and stores it.
 *
 * Nothing here throws to the caller and nothing waits on the model before the transcript is saved. Any
 * failure leaves the transcript as it is with no summary.
 */
import { and, eq } from "drizzle-orm";
import { DEFAULT_AI_SUMMARIES_ENABLED, type SummarySourceKind } from "../../../contracts/ai-summary";
import { createDb, type Db, schema } from "../../db";
import { notifyOwner } from "../hub";
import {
  emptySummary,
  isNoMessage,
  MAX_TRANSCRIPT_CHARS,
  NO_MESSAGE,
  parseSummary,
  SUMMARY_MODEL,
  summaryInput,
} from "./summary-prompt";

const { aiSummaries, aiSummarySettings, callRecordings } = schema;

export type TranscriptReady = {
  kind: SummarySourceKind;
  /** The voicemail or call recording id. */
  id: string;
  ownerId: string;
  transcript: string;
};

/** The queue message for one summary. It carries the transcript so the job needs no source table. */
export type SummaryJob = { type: "summary"; summaryId: string; transcript: string };

/** How long one model call may take before the summary counts as failed. Replies of 25 to 40 s were seen. */
export const SUMMARY_TIMEOUT_MS = 60_000;

const errorText = (err: unknown) => String(err instanceof Error ? err.message : err).slice(0, 500);

/** Whether the owner has AI summaries on. No settings row means on. */
export async function summariesEnabled(db: Db, ownerId: string): Promise<boolean> {
  const row = await db
    .select({ enabled: aiSummarySettings.enabled })
    .from(aiSummarySettings)
    .where(eq(aiSummarySettings.ownerId, ownerId))
    .get();
  return row?.enabled ?? DEFAULT_AI_SUMMARIES_ENABLED;
}

async function queueSummary(env: Env, input: TranscriptReady): Promise<void> {
  const db = createDb(env.DB);
  if (!(await summariesEnabled(db, input.ownerId))) return;
  const transcript = input.transcript.trim();
  const source = { ownerId: input.ownerId, sourceKind: input.kind, sourceId: input.id, model: SUMMARY_MODEL };

  if (isNoMessage(transcript)) {
    const empty = emptySummary(input.kind);
    await db
      .insert(aiSummaries)
      .values({ ...source, status: "empty", ...empty })
      .onConflictDoNothing();
    return;
  }

  // The claim: only the first call for a transcript gets a row back and queues the job.
  const claimed = await db
    .insert(aiSummaries)
    .values({ ...source, status: "pending" })
    .onConflictDoNothing()
    .returning({ id: aiSummaries.id })
    .get();
  if (!claimed) return;
  const job: SummaryJob = {
    type: "summary",
    summaryId: claimed.id,
    transcript: transcript.slice(0, MAX_TRANSCRIPT_CHARS),
  };
  try {
    await env.TRANSCRIBE.send(job);
  } catch (err) {
    await db
      .update(aiSummaries)
      .set({ status: "failed", error: errorText(err) })
      .where(eq(aiSummaries.id, claimed.id));
    throw err;
  }
}

/**
 * Call once a transcript is saved. Queues its summary when the owner has summaries on. Never throws. With a
 * context the work runs after the response (waitUntil), without one it is awaited.
 */
export async function onTranscriptReady(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil"> | undefined,
  input: TranscriptReady,
): Promise<void> {
  const work = queueSummary(env, input).catch((err) =>
    console.error("summary queue failed", { kind: input.kind, id: input.id, error: errorText(err) }),
  );
  if (ctx) ctx.waitUntil(work);
  else await work;
}

export const isSummaryJob = (body: unknown): body is SummaryJob =>
  Boolean(body) &&
  typeof body === "object" &&
  (body as SummaryJob).type === "summary" &&
  typeof (body as SummaryJob).summaryId === "string" &&
  typeof (body as SummaryJob).transcript === "string";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("summary timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Runs one summary job: asks the model, checks the reply and stores it. Never throws. A bad or missing reply
 * marks the summary failed and is not retried, the transcript stays as it is.
 */
export async function runSummaryJob(
  env: Env,
  job: SummaryJob,
): Promise<"done" | "empty" | "failed" | "skipped"> {
  const db = createDb(env.DB);
  const row = await db.select().from(aiSummaries).where(eq(aiSummaries.id, job.summaryId)).get();
  if (row?.status !== "pending") return "skipped";
  const pending = and(eq(aiSummaries.id, row.id), eq(aiSummaries.status, "pending"));
  // The owner may have switched summaries off since the job was queued: then nothing goes to the model.
  if (!(await summariesEnabled(db, row.ownerId))) {
    await db.update(aiSummaries).set({ status: "failed", error: "summaries off" }).where(pending);
    return "skipped";
  }
  let status: "done" | "empty" | "failed";
  try {
    const input = summaryInput(row.sourceKind, job.transcript);
    const result = input
      ? parseSummary(
          row.sourceKind,
          await withTimeout(
            env.AI.run(SUMMARY_MODEL, input as never, { gateway: { id: env.AI_GATEWAY_ID ?? "default" } }),
            SUMMARY_TIMEOUT_MS,
          ),
          job.transcript,
        )
      : emptySummary(row.sourceKind);
    status = input && result.summary !== NO_MESSAGE ? "done" : "empty";
    await db
      .update(aiSummaries)
      .set({ status, ...result, error: null })
      .where(pending);
  } catch (err) {
    console.error("summary failed", { summaryId: row.id, error: errorText(err) });
    status = "failed";
    await db
      .update(aiSummaries)
      .set({ status, error: errorText(err) })
      .where(pending)
      .catch(() => {});
  }
  if (status !== "failed") await notifySummary(env, db, row).catch(() => {});
  return status;
}

/** Tells the owner's screens that a summary is ready, as the voicemail or the recording it belongs to. */
async function notifySummary(env: Env, db: Db, row: typeof aiSummaries.$inferSelect) {
  if (row.sourceKind === "voicemail") {
    await notifyOwner(env, row.ownerId, { type: "voicemail", voicemailId: row.sourceId });
    return;
  }
  const rec = await db
    .select({ callId: callRecordings.callId })
    .from(callRecordings)
    .where(and(eq(callRecordings.id, row.sourceId), eq(callRecordings.ownerId, row.ownerId)))
    .get();
  if (rec)
    await notifyOwner(env, row.ownerId, { type: "recording", callId: rec.callId, recordingId: row.sourceId });
}

/** Deletes the summary of a transcript whose source is being deleted. */
export async function deleteSummary(db: Db, ownerId: string, kind: SummarySourceKind, id: string) {
  await db
    .delete(aiSummaries)
    .where(
      and(eq(aiSummaries.ownerId, ownerId), eq(aiSummaries.sourceKind, kind), eq(aiSummaries.sourceId, id)),
    );
}
