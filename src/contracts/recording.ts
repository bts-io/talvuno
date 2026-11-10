/** Contracts for call recording: per-number settings, the recordings of a call, and the live switch. */
import { z } from "zod";
import { aiSummarySchema } from "./ai-summary";
import { idSchema } from "./index";
import { transcriptStatusSchema } from "./voicemail";

/** Longest spoken notice the setting accepts, in characters. */
export const RECORDING_NOTICE_MAX = 300;

export const numberRecordingSchema = z.object({
  numberId: idSchema,
  /** Record every outbound and answered inbound call on this number. Off by default. */
  recordCalls: z.boolean(),
  /** Play the notice to the other party before a recorded call connects. Off by default. */
  playNotice: z.boolean(),
  /** The notice text. Null means the default text. */
  noticeText: z.string().nullable(),
});
export type NumberRecording = z.infer<typeof numberRecordingSchema>;

export const numberRecordingListSchema = z.object({ items: z.array(numberRecordingSchema) });
export type NumberRecordingList = z.infer<typeof numberRecordingListSchema>;

export const numberRecordingUpdateSchema = z.object({
  recordCalls: z.boolean(),
  playNotice: z.boolean(),
  /** Empty or null goes back to the default text. */
  noticeText: z.string().trim().max(RECORDING_NOTICE_MAX).nullable(),
});
export type NumberRecordingUpdate = z.infer<typeof numberRecordingUpdateSchema>;

export const callRecordingSchema = z.object({
  id: idSchema,
  callId: idSchema,
  duration: z.number().int().nonnegative().nullable(),
  /** 2 when each side is on its own channel. */
  channels: z.number().int().min(1).max(2),
  /** False while the audio is still on its way from Twilio. */
  audioReady: z.boolean(),
  transcript: z.string().nullable(),
  transcriptStatus: transcriptStatusSchema,
  /** The AI summary once there is one. Null while pending, when it failed or when summaries are off. */
  aiSummary: aiSummarySchema.nullable(),
  createdAt: z.number().int().nonnegative(),
});
export type CallRecording = z.infer<typeof callRecordingSchema>;

export const callRecordingListSchema = z.object({ items: z.array(callRecordingSchema) });
export type CallRecordingList = z.infer<typeof callRecordingListSchema>;

/** A CallSid as the browser knows its own leg. */
export const callSidSchema = z.string().regex(/^CA[0-9a-f]{32}$/i);

export const LIVE_RECORDING_STATES = ["off", "recording", "paused"] as const;
export const liveRecordingStateSchema = z.object({ state: z.enum(LIVE_RECORDING_STATES) });
export type LiveRecordingState = z.infer<typeof liveRecordingStateSchema>;

export const liveRecordingQuerySchema = z.object({ callSid: callSidSchema });

export const liveRecordingActionSchema = z.object({
  callSid: callSidSchema,
  action: z.enum(["start", "pause", "resume"]),
});
export type LiveRecordingAction = z.infer<typeof liveRecordingActionSchema>;
