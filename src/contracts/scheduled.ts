/** Shapes of /api/scheduled-messages: texts the owner scheduled to go out later. */
import { z } from "zod";
import { idSchema, SMS_BODY_MAX } from "./index";

export const SCHEDULED_STATUSES = ["scheduled", "sending", "sent", "failed", "cancelled"] as const;
export type ScheduledStatus = (typeof SCHEDULED_STATUSES)[number];

/** A text must be scheduled at least this far ahead and at most a year ahead. */
export const SCHEDULE_MIN_LEAD_MS = 2 * 60 * 1000;
export const SCHEDULE_MAX_LEAD_MS = 365 * 24 * 60 * 60 * 1000;

export const scheduledMessageSchema = z.object({
  id: idSchema,
  numberId: idSchema,
  numberE164: z.string(),
  to: z.string(),
  body: z.string(),
  sendAt: z.number().int().nonnegative(),
  status: z.enum(SCHEDULED_STATUSES),
  messageId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
});
export type ScheduledMessage = z.infer<typeof scheduledMessageSchema>;

const sendAtSchema = z.number().int().nonnegative();
const bodySchema = z.string().min(1).max(SMS_BODY_MAX);

export const scheduleInputSchema = z
  .object({ numberId: idSchema, to: z.string().min(1).max(64), body: bodySchema, sendAt: sendAtSchema })
  .strict();
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

export const schedulePatchSchema = z
  .object({ body: bodySchema.optional(), sendAt: sendAtSchema.optional() })
  .strict()
  .refine((v) => v.body !== undefined || v.sendAt !== undefined, { message: "Nothing to change" });

/** Null when `sendAt` is acceptable at `now`, else the reason. */
export function sendAtProblem(sendAt: number, now = Date.now()): "too_soon" | "too_far" | null {
  if (sendAt < now + SCHEDULE_MIN_LEAD_MS) return "too_soon";
  if (sendAt > now + SCHEDULE_MAX_LEAD_MS) return "too_far";
  return null;
}
