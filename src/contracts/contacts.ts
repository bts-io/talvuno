/** Contracts for the contacts and call history APIs. */
import { z } from "zod";
import { callSchema, contactSchema } from "./index";

export const CONTACT_PAGE_MAX = 50;
export const VCARD_MAX_BYTES = 1_000_000;

export const contactListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(CONTACT_PAGE_MAX).default(30),
});

export const contactListSchema = z.object({
  items: z.array(contactSchema),
  nextCursor: z.string().nullable(),
});
export type ContactList = z.infer<typeof contactListSchema>;

export const contactLookupQuerySchema = z.object({ number: z.string().min(1).max(40) });

export const vcardImportResultSchema = z.object({
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type VcardImportResult = z.infer<typeof vcardImportResultSchema>;

// Call history

export const callFilterSchema = z.enum(["all", "missed"]);
export type CallFilter = z.infer<typeof callFilterSchema>;

export const callListQuerySchema = z.object({
  filter: callFilterSchema.default("all"),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/** A call row plus what the history screen needs: the contact's name and whether it counts as missed. */
export const callEntrySchema = callSchema.extend({
  contactName: z.string().nullable(),
  missed: z.boolean(),
});
export type CallEntry = z.infer<typeof callEntrySchema>;

export const callListSchema = z.object({
  items: z.array(callEntrySchema),
  nextCursor: z.string().nullable(),
});
export type CallList = z.infer<typeof callListSchema>;

/** An inbound call that ended in one of these was not answered. */
export const MISSED_STATUSES = ["no-answer", "busy", "canceled", "failed"] as const;

/**
 * A missed call: inbound, ended without being answered. The one definition for the recents list, the missed
 * filter and the missed call push. An answered inbound call always ends "completed" (the voice rules make
 * sure of that), so the unanswered ends are exactly MISSED_STATUSES with no answer time.
 */
export const isMissedCall = (call: {
  direction: string;
  status: string;
  answeredAt?: Date | number | null;
}) =>
  call.direction === "inbound" &&
  (MISSED_STATUSES as readonly string[]).includes(call.status) &&
  (call.answeredAt === null || call.answeredAt === undefined);
