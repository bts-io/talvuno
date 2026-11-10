/**
 * Shapes of the /api/messages endpoints (conversation list, thread pages, send, search). The base
 * `messageSchema` and `conversationSchema` live in ./index; these add what the screens need around them.
 */
import { z } from "zod";
import { conversationSchema, idSchema, messageSchema, SMS_BODY_MAX } from "./index";

export const mediaNoteSchema = z.object({
  count: z.number().int().positive(),
  contentTypes: z.array(z.string()),
});
export type MediaNote = z.infer<typeof mediaNoteSchema>;

export const threadMessageSchema = messageSchema.extend({
  errorMessage: z.string().nullable(),
  clientId: z.string().nullable(),
  media: mediaNoteSchema.nullable(),
});
export type ThreadMessage = z.infer<typeof threadMessageSchema>;

export const conversationListItemSchema = conversationSchema.extend({
  contactName: z.string().nullable(),
  numberE164: z.string(),
  pinnedAt: z.number().int().nonnegative().nullable(),
  archivedAt: z.number().int().nonnegative().nullable(),
  /** The owner marked the thread unread by hand. */
  markedUnread: z.boolean(),
});
export type ConversationListItem = z.infer<typeof conversationListItemSchema>;

export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export type Page<T> = { items: T[]; nextCursor: string | null };

export const sendSmsInputSchema = z.object({
  numberId: idSchema,
  to: z.string().min(1).max(64),
  body: z.string().min(1).max(SMS_BODY_MAX),
  clientId: z.uuid(),
});
export const pinInputSchema = z.object({ pinned: z.boolean() }).strict();
export const archiveInputSchema = z.object({ archived: z.boolean() }).strict();
export const unreadInputSchema = z.object({ unread: z.boolean() }).strict();

export type SendSmsInput = z.infer<typeof sendSmsInputSchema>;

export type SendSmsResult = { message: ThreadMessage; conversationId: string };

export const smsNumberSchema = z.object({
  id: idSchema,
  e164: z.string(),
  friendlyName: z.string(),
  isDefault: z.boolean(),
});
export type SmsNumber = z.infer<typeof smsNumberSchema>;

// Quick replies and the missed-call text

export const QUICK_REPLY_MAX = 160;
export const QUICK_REPLY_LIMIT = 50;

export const quickReplyTextSchema = z.string().trim().min(1).max(QUICK_REPLY_MAX);

export const quickReplySchema = z.object({ id: idSchema, text: z.string(), sortOrder: z.number().int() });
export type QuickReply = z.infer<typeof quickReplySchema>;

export const quickReplyInputSchema = z.object({ text: quickReplyTextSchema });
export const quickReplyPatchSchema = z
  .object({
    text: quickReplyTextSchema.optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((v) => v.text !== undefined || v.sortOrder !== undefined, { message: "Nothing to change" });

export const missedCallTextSchema = z.object({
  numberId: idSchema,
  e164: z.string(),
  friendlyName: z.string(),
  enabled: z.boolean(),
  text: z.string(),
});
export type MissedCallText = z.infer<typeof missedCallTextSchema>;

export const missedCallTextInputSchema = z.object({
  enabled: z.boolean(),
  text: z.string().trim().max(QUICK_REPLY_MAX),
});

export type SearchResult = {
  messages: (ThreadMessage & { participant: string; contactName: string | null })[];
  conversations: ConversationListItem[];
};
