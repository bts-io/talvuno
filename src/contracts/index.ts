/**
 * Runtime contracts shared by the Worker and the browser. Every request body, response body and live event
 * has a Zod schema here; the TypeScript types are inferred from it, never written by hand.
 */
import { z } from "zod";
import { isCountryCode, isE164, toE164 } from "../lib/phone";
import { callOutcomeSchema, callStatusSchema, messageStatusSchema } from "./status";

export * from "./status";

/** A number already in E.164 form (what the API returns and what Twilio sends). */
export const e164Schema = z.string().refine(isE164, { message: "Expected an E.164 phone number" });

const SHORT_CODE = /^\d{3,8}$/;
const SENDER_ID = /^(?=.*[A-Za-z])[A-Za-z0-9 ]{1,11}$/;
const WITHHELD_CALLERS = new Set(["anonymous", "restricted", "unavailable", "unknown", ""]);

/**
 * Who an SMS came from or went to, as Twilio reports it: an E.164 number, a short code (3 to 8 digits) or an
 * alphanumeric sender ID (1 to 11 characters with at least one letter). Stored as received, never reformatted.
 */
export const addressSchema = z.string().refine((v) => isE164(v) || SHORT_CODE.test(v) || SENDER_ID.test(v), {
  message: "Expected an E.164 number, a short code or an alphanumeric sender ID",
});

/** A call party: any address, or the placeholder Twilio sends when the caller hides their number. */
export const callerSchema = z
  .string()
  .refine((v) => WITHHELD_CALLERS.has(v.toLowerCase()) || addressSchema.safeParse(v).success, {
    message: "Expected an address or a withheld-caller placeholder",
  });

/** A number as a person typed it: normalized to E.164, rejected when it is not a valid number. */
export const dialableSchema = z.string().transform((value, ctx) => {
  const e164 = toE164(value);
  if (!e164) {
    ctx.addIssue({ code: "custom", message: "Not a valid phone number" });
    return z.NEVER;
  }
  return e164;
});

export const countryCodeSchema = z
  .string()
  .length(2)
  .transform((s) => s.toUpperCase())
  .refine(isCountryCode, { message: "Unknown country code" });

export const idSchema = z.string().min(1).max(64);
const timestamp = z.number().int().nonnegative();

// Auth and setup

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export const setupInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email().max(254),
  password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
  /** The deployment's SETUP_TOKEN secret, so only whoever deployed it can claim the owner account. */
  setupToken: z.string().max(256).default(""),
});
export type SetupInput = z.infer<typeof setupInputSchema>;

export const setupStatusSchema = z.object({ needed: z.boolean() });
export type SetupStatus = z.infer<typeof setupStatusSchema>;

/** Public sign-in settings: whether to show the SSO button and what it says. */
export const authConfigSchema = z.object({ oidc: z.boolean(), oidcLabel: z.string() });
export type AuthConfig = z.infer<typeof authConfigSchema>;

export const meSchema = z.object({
  id: idSchema,
  name: z.string(),
  email: z.string(),
});
export type Me = z.infer<typeof meSchema>;

// Numbers

export const capabilitiesSchema = z.object({
  voice: z.boolean(),
  sms: z.boolean(),
  mms: z.boolean(),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

export const phoneNumberSchema = z.object({
  id: idSchema,
  e164: e164Schema,
  twilioSid: z.string().regex(/^PN[0-9a-f]{32}$/i),
  friendlyName: z.string().max(100),
  capabilities: capabilitiesSchema,
  isDefault: z.boolean(),
});
export type PhoneNumber = z.infer<typeof phoneNumberSchema>;

// Contacts

export const contactNumberSchema = z.object({
  id: idSchema,
  e164: e164Schema,
  label: z.string().max(40).nullable(),
});
export type ContactNumber = z.infer<typeof contactNumberSchema>;

export const contactSchema = z.object({
  id: idSchema,
  displayName: z.string().min(1).max(200),
  company: z.string().max(200).nullable(),
  notes: z.string().max(4000).nullable(),
  numbers: z.array(contactNumberSchema),
  updatedAt: timestamp,
});
export type Contact = z.infer<typeof contactSchema>;

export const contactInputSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  company: z.string().trim().max(200).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  numbers: z
    .array(z.object({ number: dialableSchema, label: z.string().trim().max(40).nullable().optional() }))
    .max(20),
});
export type ContactInput = z.input<typeof contactInputSchema>;

// Messages and conversations

export const directionSchema = z.enum(["inbound", "outbound"]);
export type Direction = z.infer<typeof directionSchema>;

/** One SMS segment set is at most 1600 characters on Twilio; longer bodies are refused. */
export const SMS_BODY_MAX = 1600;

export const messageSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  twilioSid: z.string().nullable(),
  direction: directionSchema,
  from: addressSchema,
  to: addressSchema,
  body: z.string(),
  status: messageStatusSchema,
  errorCode: z.number().int().nullable(),
  sentAt: timestamp.nullable(),
  createdAt: timestamp,
});
export type Message = z.infer<typeof messageSchema>;

export const conversationSchema = z.object({
  id: idSchema,
  numberId: idSchema,
  participant: addressSchema,
  lastMessageAt: timestamp.nullable(),
  lastMessagePreview: z.string().nullable(),
  unreadCount: z.number().int().nonnegative(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const sendMessageInputSchema = z.object({
  numberId: idSchema,
  to: dialableSchema,
  body: z.string().min(1).max(SMS_BODY_MAX),
});
export type SendMessageInput = z.input<typeof sendMessageInputSchema>;

// Calls

export const callSchema = z.object({
  id: idSchema,
  twilioCallSid: z.string(),
  parentCallSid: z.string().nullable(),
  direction: directionSchema,
  numberId: idSchema.nullable(),
  party: callerSchema,
  status: callStatusSchema,
  startedAt: timestamp.nullable(),
  answeredAt: timestamp.nullable(),
  endedAt: timestamp.nullable(),
  duration: z.number().int().nonnegative().nullable(),
  /** Twilio's error code when the call could not connect (13227 and the like), and its short message. */
  errorCode: z.number().int().positive().nullable(),
  errorMessage: z.string().nullable(),
  contactId: idSchema.nullable(),
  /** How an inbound call ended (answered, missed, voicemail, declined, blocked); null while live or outbound. */
  outcome: callOutcomeSchema.nullable(),
});
export type Call = z.infer<typeof callSchema>;

// Preferences

export const preferencesSchema = z.object({
  defaultNumberId: idSchema.nullable(),
  countryAllowlist: z.array(countryCodeSchema).max(250),
  locale: z.string().min(2).max(10),
  theme: z.enum(["system", "light", "dark"]),
  smsPerHour: z.number().int().min(0).max(10_000),
  callsPerHour: z.number().int().min(0).max(1_000),
});
export type Preferences = z.infer<typeof preferencesSchema>;

// Live events (OwnerHub WebSocket)

/**
 * Optional notice for the owner's devices. The hub sends it as a web push when the event reaches no open
 * socket (missed calls, inbound messages). Never holds secrets.
 */
const cutTo = (max: number) => (value: string) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}\u2026`;

export const livePushSchema = z.object({
  title: z.string().transform(cutTo(120)),
  body: z.string().transform(cutTo(300)),
  /** A same-origin path only, so a notice can never open another site. */
  url: z
    .string()
    .max(200)
    .refine(
      (u) => u.startsWith("/") && !u.startsWith("//") && !u.includes("\\"),
      "url must be a same-origin path",
    ),
  tag: z.string().max(100).optional(),
  /** Keep the notice on screen until the owner acts on it, where the platform supports it. */
  requireInteraction: z.boolean().optional(),
  /** Web Push urgency. "high" for a ringing call, so a sleeping phone wakes for it. */
  urgency: z.enum(["normal", "high"]).optional(),
  /** Seconds the push service may hold the notice for an offline device. Defaults to a day. */
  ttl: z.number().int().positive().max(86_400).optional(),
});
export type LivePush = z.infer<typeof livePushSchema>;

export const liveEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    conversationId: idSchema,
    messageId: idSchema,
    push: livePushSchema.optional(),
  }),
  z.object({
    type: z.literal("call"),
    callId: idSchema,
    status: callStatusSchema,
    /** The call's parent CallSid (calls.twilio_call_sid), so only the tab that placed the call shows its failure. */
    callSid: z.string().optional(),
    errorCode: z.number().int().positive().optional(),
    errorMessage: z.string().optional(),
    push: livePushSchema.optional(),
  }),
  z.object({ type: z.literal("conversation"), conversationId: idSchema, push: livePushSchema.optional() }),
  /**
   * An inbound call waiting for the owner. "ringing" opens the incoming sheet on every open screen. "ended"
   * closes it everywhere: answered on a device, declined, gone to voicemail or the caller hung up.
   */
  z.object({
    type: z.literal("incoming"),
    callId: idSchema,
    state: z.enum(["ringing", "ended"]),
    party: z.string().max(64).optional(),
    contactName: z.string().max(200).nullable().optional(),
    numberId: idSchema.optional(),
    push: livePushSchema.optional(),
  }),
]);
export type LiveEvent = z.infer<typeof liveEventSchema>;

/** What the hub sends first on every new socket. Not a data event, so clients do not invalidate on it. */
export const liveHelloSchema = z.object({ type: z.literal("hello"), online: z.number().int() });

// Errors

export const apiErrorSchema = z.object({ error: z.string(), message: z.string() });
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
