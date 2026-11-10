/**
 * Inbound call routing contracts: the per-number ring time, greeting and hours, the owner's do not disturb
 * switch, the block list and the calls waiting for an answer.
 */
import { z } from "zod";
import { businessHoursSchema } from "../lib/business-hours";
import { addressSchema, idSchema } from "./index";

const WITHHELD = new Set(["anonymous", "restricted", "unavailable", "unknown"]);

export const RING_SECONDS_DEFAULT = 25;
export const RING_SECONDS_MIN = 10;
export const RING_SECONDS_MAX = 60;
export const GREETING_MAX = 500;

export const numberRoutingSchema = z.object({
  numberId: idSchema,
  ringSeconds: z.number().int().min(RING_SECONDS_MIN).max(RING_SECONDS_MAX),
  /** Null means the default greeting. */
  voicemailGreeting: z.string().max(GREETING_MAX).nullable(),
  /** Null means always open. */
  hours: businessHoursSchema.nullable(),
});
export type NumberRouting = z.infer<typeof numberRoutingSchema>;

export const numberRoutingInputSchema = z.object({
  ringSeconds: z.number().int().min(RING_SECONDS_MIN).max(RING_SECONDS_MAX).optional(),
  voicemailGreeting: z
    .string()
    .trim()
    .max(GREETING_MAX)
    .nullable()
    .optional()
    .transform((v) => (v === "" ? null : v)),
  hours: businessHoursSchema.nullable().optional(),
});
export type NumberRoutingInput = z.input<typeof numberRoutingInputSchema>;

export const routingSettingsSchema = z.object({ dnd: z.boolean() });
export type RoutingSettings = z.infer<typeof routingSettingsSchema>;

export const blockedNumberSchema = z.object({
  id: idSchema,
  address: z.string(),
  createdAt: z.number().int().nonnegative(),
});
export type BlockedNumber = z.infer<typeof blockedNumberSchema>;

/** A number or sender to block, stored exactly as Twilio reports it (withheld callers cannot be blocked). */
export const blockInputSchema = z.object({
  address: z.string().refine((v) => addressSchema.safeParse(v).success && !WITHHELD.has(v.toLowerCase()), {
    message: "A withheld number cannot be blocked",
  }),
});
export type BlockInput = z.infer<typeof blockInputSchema>;

/** A call waiting in its queue for the owner to answer. */
export const incomingCallSchema = z.object({
  callId: idSchema,
  party: z.string(),
  contactName: z.string().nullable(),
  numberId: idSchema.nullable(),
  startedAt: z.number().int().nonnegative(),
});
export type IncomingCallInfo = z.infer<typeof incomingCallSchema>;

/** The notification tag of a ringing call, so the app can close the notice once the call is answered or ends. */
export const incomingCallTag = (callId: string) => `call-${callId}`;
