/** Contracts for the voicemail API (/api/voicemails). */
import { z } from "zod";
import { callerSchema, idSchema } from "./index";

export const TRANSCRIPT_STATUSES = ["pending", "done", "failed"] as const;
export const transcriptStatusSchema = z.enum(TRANSCRIPT_STATUSES);
export type TranscriptStatus = z.infer<typeof transcriptStatusSchema>;

export const VOICEMAIL_PAGE_MAX = 100;

export const voicemailListQuerySchema = z.object({
  /** Matches the transcript or the caller's number. */
  q: z.string().trim().max(100).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(VOICEMAIL_PAGE_MAX).default(30),
});

export const voicemailSchema = z.object({
  id: idSchema,
  callId: idSchema,
  numberId: idSchema.nullable(),
  from: callerSchema,
  contactName: z.string().nullable(),
  duration: z.number().int().nonnegative().nullable(),
  /** False while the audio is still on its way from Twilio. */
  audioReady: z.boolean(),
  transcript: z.string().nullable(),
  transcriptStatus: transcriptStatusSchema,
  createdAt: z.number().int().nonnegative(),
  listenedAt: z.number().int().nonnegative().nullable(),
});
export type Voicemail = z.infer<typeof voicemailSchema>;

export const voicemailListSchema = z.object({
  items: z.array(voicemailSchema),
  nextCursor: z.string().nullable(),
  /** Voicemails not listened to yet, across every page. */
  unheard: z.number().int().nonnegative(),
});
export type VoicemailList = z.infer<typeof voicemailListSchema>;

/** Longest retention the setting accepts: ten years. 0 keeps voicemail forever. */
export const VOICEMAIL_RETENTION_MAX_DAYS = 3650;
export const DEFAULT_VOICEMAIL_RETENTION_DAYS = 90;

export const voicemailSettingsSchema = z.object({
  retentionDays: z.number().int().min(0).max(VOICEMAIL_RETENTION_MAX_DAYS),
});
export type VoicemailSettings = z.infer<typeof voicemailSettingsSchema>;
