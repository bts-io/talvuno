/** Contracts for AI summaries of transcripts (/api/ai-summaries and the summary on a voicemail). */
import { z } from "zod";

export const SUMMARY_SOURCE_KINDS = ["voicemail", "call"] as const;
export const summarySourceKindSchema = z.enum(SUMMARY_SOURCE_KINDS);
export type SummarySourceKind = z.infer<typeof summarySourceKindSchema>;

/** pending: queued for the model. done: has a summary. empty: no message in the transcript. failed: no summary. */
export const SUMMARY_STATUSES = ["pending", "done", "empty", "failed"] as const;
export const summaryStatusSchema = z.enum(SUMMARY_STATUSES);
export type SummaryStatus = z.infer<typeof summaryStatusSchema>;

/** A finished summary as the app shows it. Pending and failed summaries are not sent. */
export const aiSummarySchema = z.object({
  summary: z.string(),
  actionItems: z.array(z.string()).max(3),
  /** What the caller wanted, for voicemail only. */
  oneLiner: z.string().nullable(),
});
export type AiSummary = z.infer<typeof aiSummarySchema>;

/** Off means no transcript is sent to the model. On by default. */
export const aiSummarySettingsSchema = z.object({ enabled: z.boolean() });
export type AiSummarySettings = z.infer<typeof aiSummarySettingsSchema>;
export const DEFAULT_AI_SUMMARIES_ENABLED = true;
