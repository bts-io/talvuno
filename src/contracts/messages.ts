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
export type SendSmsInput = z.infer<typeof sendSmsInputSchema>;

export type SendSmsResult = { message: ThreadMessage; conversationId: string };

export const smsNumberSchema = z.object({
  id: idSchema,
  e164: z.string(),
  friendlyName: z.string(),
  isDefault: z.boolean(),
});
export type SmsNumber = z.infer<typeof smsNumberSchema>;

export type SearchResult = {
  messages: (ThreadMessage & { participant: string; contactName: string | null })[];
  conversations: ConversationListItem[];
};
