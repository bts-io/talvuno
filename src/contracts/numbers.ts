/** Contracts for the numbers, billing and status screens. Shared by the Worker routes and the Settings UI. */
import { z } from "zod";
import { idSchema } from "./index";

export const numberCapabilitiesSchema = z.object({ voice: z.boolean(), sms: z.boolean(), mms: z.boolean() });

/** The voice and SMS routing of a number at Twilio. Null means Twilio has no value set. */
export const numberRoutingSchema = z.object({
  voiceUrl: z.string().nullable(),
  voiceMethod: z.string().nullable(),
  smsUrl: z.string().nullable(),
  smsMethod: z.string().nullable(),
  statusCallback: z.string().nullable(),
  statusCallbackMethod: z.string().nullable(),
  voiceApplicationSid: z.string().nullable(),
});
export type NumberRouting = z.infer<typeof numberRoutingSchema>;

export const phoneNumberSchema = z.object({
  id: idSchema,
  e164: z.string(),
  twilioSid: z.string(),
  friendlyName: z.string(),
  capabilities: numberCapabilitiesSchema,
  isDefault: z.boolean(),
  /** Epoch ms, or null while the number is active. */
  releasedAt: z.number().nullable(),
  /** The routing stored before the last "connect", when it can still be restored. */
  restorable: numberRoutingSchema.nullable(),
});
export type PhoneNumberRow = z.infer<typeof phoneNumberSchema>;

export const numberPatchSchema = z
  .object({
    friendlyName: z.string().trim().max(64).optional(),
    isDefault: z.literal(true).optional(),
  })
  .refine((v) => v.friendlyName !== undefined || v.isDefault !== undefined, {
    message: "Nothing to change",
  });

export interface ConnectResult {
  /** False when the number already pointed at this deployment: nothing was changed. */
  changed: boolean;
  before: NumberRouting;
  after: NumberRouting;
}

export interface BillingUsageLine {
  count: string | null;
  usage: string | null;
  usageUnit: string | null;
  price: string | null;
  priceUnit: string | null;
}

export interface Billing {
  balance: { amount: string; currency: string };
  period: { start: string | null; end: string | null; label: "this month" };
  usage: { calls: BillingUsageLine; sms: BillingUsageLine; total: BillingUsageLine };
  /** Epoch ms of the Twilio read. Answers are cached for five minutes. */
  fetchedAt: number;
}

export interface ConfigStatus {
  twilioAccountSid: boolean;
  twilioApiKey: boolean;
  twilioAuthToken: boolean;
  twilioTwimlApp: boolean;
  publicUrl: boolean;
  vapid: boolean;
  oidc: boolean;
  setupToken: boolean;
}

export type TwilioTestResult =
  | { ok: true; currency: string }
  | { ok: false; error: string; code?: number | null };
