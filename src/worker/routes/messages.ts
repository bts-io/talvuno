/**
 * The owner's SMS API, mounted at /api/messages (session and Origin checked by the app).
 *
 *   GET  /numbers                            numbers a message can go out from
 *   POST /send                               send one SMS (idempotent on clientId)
 *   GET  /conversations?numberId&cursor&q    threads, newest activity first
 *   GET  /conversations/:id                  one thread's header
 *   GET  /conversations/:id/messages?cursor  a thread's messages, newest first
 *   POST /conversations/:id/read             marks a thread read
 *   GET  /search?q                           message bodies and contact names
 */
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  type ConversationListItem,
  type Page,
  type SearchResult,
  type SendSmsResult,
  type SmsNumber,
  sendSmsInputSchema,
  type ThreadMessage,
} from "../../contracts/messages";
import { nextMessageStatus } from "../../contracts/status";
import { toE164 } from "../../lib/phone";
import { contactNumbers, contacts, conversations, messages, phoneNumbers } from "../db/schema";
import { ApiError } from "../lib/errors";
import {
  applyPendingStatuses,
  likeEscape,
  notify,
  type TwilioMessage,
  toThreadMessage,
  touchConversation,
  upsertConversation,
} from "../lib/sms";
import { assertCanContact } from "../lib/twilio/guards";
import { TwilioApiError, TwilioNotConfiguredError, twilioRest } from "../lib/twilio/rest";
import { validationHook } from "../lib/validation";
import type { AppEnv } from "../types";

export const messagesApi = new Hono<AppEnv>();

export const PAGE_SIZE = 30;
const SEARCH_LIMIT = 50;

/** Opaque page cursor: the last item's sort time and id. */
const encodeCursor = (at: number, id: string) => `${at}:${id}`;
function decodeCursor(cursor: string | undefined): { at: number; id: string } | null {
  if (!cursor) return null;
  const i = cursor.indexOf(":");
  const at = Number(cursor.slice(0, i));
  const id = cursor.slice(i + 1);
  if (i < 1 || !Number.isSafeInteger(at) || !id || id.length > 64)
    throw new ApiError(400, "invalid_cursor", "Invalid cursor");
  return { at, id };
}

const contactNameSql = sql<string | null>`(
  SELECT ${contacts.displayName} FROM ${contactNumbers}
  JOIN ${contacts} ON ${contacts.id} = ${contactNumbers.contactId}
  WHERE ${contactNumbers.e164} = ${conversations.participant} AND ${contacts.ownerId} = ${conversations.ownerId}
  ORDER BY ${contacts.sortKey}, ${contacts.id} LIMIT 1
)`;

const conversationColumns = {
  id: conversations.id,
  numberId: conversations.numberId,
  numberE164: phoneNumbers.e164,
  participant: conversations.participant,
  lastMessageAt: conversations.lastMessageAt,
  lastMessagePreview: conversations.lastMessagePreview,
  unreadCount: conversations.unreadCount,
  contactName: contactNameSql,
};

type ConversationRow = {
  id: string;
  numberId: string;
  numberE164: string;
  participant: string;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  contactName: string | null;
};

const toListItem = (r: ConversationRow): ConversationListItem => ({
  ...r,
  lastMessageAt: r.lastMessageAt ? r.lastMessageAt.getTime() : null,
});

const sortTime = sql<number>`COALESCE(${conversations.lastMessageAt}, 0)`;

const likeOf = (q: string) => `%${likeEscape(q)}%`;
const escapeLike = (column: SQL | typeof contacts.displayName, q: string) =>
  sql`${column} LIKE ${likeOf(q)} ESCAPE '\\'`;

messagesApi.get("/numbers", async (c) => {
  const ownerId = c.get("user")!.id;
  const rows = await c
    .get("db")
    .select({
      id: phoneNumbers.id,
      e164: phoneNumbers.e164,
      friendlyName: phoneNumbers.friendlyName,
      isDefault: phoneNumbers.isDefault,
    })
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.ownerId, ownerId), isNull(phoneNumbers.releasedAt)))
    .orderBy(desc(phoneNumbers.isDefault), phoneNumbers.e164)
    .all();
  return c.json(rows satisfies SmsNumber[]);
});

messagesApi.post("/send", zValidator("json", sendSmsInputSchema, validationHook), async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const input = c.req.valid("json");

  // The same clientId never sends twice: a retried POST gets the stored row back.
  const existing = await db
    .select()
    .from(messages)
    .where(and(eq(messages.ownerId, ownerId), eq(messages.clientId, input.clientId)))
    .get();
  if (existing)
    return c.json({
      message: toThreadMessage(existing),
      conversationId: existing.conversationId,
    } satisfies SendSmsResult);

  const number = await db
    .select()
    .from(phoneNumbers)
    .where(
      and(
        eq(phoneNumbers.id, input.numberId),
        eq(phoneNumbers.ownerId, ownerId),
        isNull(phoneNumbers.releasedAt),
      ),
    )
    .get();
  if (!number) throw new ApiError(404, "number_not_found", "That number is not one of yours");

  const to = toE164(input.to) ?? input.to.trim();
  await assertCanContact(c, ownerId, to, "sms");

  const conversation = await upsertConversation(db, ownerId, number.id, to);
  const createdAt = new Date();
  const inserted = await db
    .insert(messages)
    .values({
      ownerId,
      conversationId: conversation.id,
      direction: "outbound",
      from: number.e164,
      to,
      body: input.body,
      status: "queued",
      clientId: input.clientId,
      createdAt,
    })
    .onConflictDoNothing()
    .returning()
    .get();
  if (!inserted) {
    // Lost a race with the same clientId: the other request sends it.
    const row = await db
      .select()
      .from(messages)
      .where(and(eq(messages.ownerId, ownerId), eq(messages.clientId, input.clientId)))
      .get();
    if (!row) throw new ApiError(409, "conflict", "Try again");
    return c.json({
      message: toThreadMessage(row),
      conversationId: row.conversationId,
    } satisfies SendSmsResult);
  }
  await touchConversation(db, conversation.id, { createdAt, body: input.body, direction: "outbound" });

  let row = inserted;
  let sent: TwilioMessage | null = null;
  try {
    sent = await twilioRest(c.env).post<TwilioMessage>("/Messages.json", {
      From: number.e164,
      To: to,
      Body: input.body,
      StatusCallback: `${c.env.PUBLIC_URL.replace(/\/+$/, "")}/api/twilio/sms/status`,
    });
  } catch (err) {
    const failure =
      err instanceof TwilioApiError
        ? { errorCode: err.code, errorMessage: err.message.slice(0, 500) }
        : err instanceof TwilioNotConfiguredError
          ? { errorCode: null, errorMessage: "Twilio is not configured on this deployment" }
          : { errorCode: null, errorMessage: "Could not reach Twilio" };
    if (!(err instanceof TwilioApiError))
      console.error("sms send failed", { messageId: row.id, error: String(err) });
    row =
      (await db
        .update(messages)
        .set({ status: "failed", ...failure })
        .where(eq(messages.id, row.id))
        .returning()
        .get()) ?? row;
  }

  if (sent) {
    // Twilio accepted the message: a D1 failure here must not mark it failed.
    try {
      const status = nextMessageStatus("queued", parseStatus(sent.status) ?? "queued");
      row =
        (await db
          .update(messages)
          .set({ twilioSid: sent.sid, status: nextMessageStatus(row.status, status) })
          .where(eq(messages.id, row.id))
          .returning()
          .get()) ?? row;
      // A status callback may have arrived before we knew the SID.
      row = (await applyPendingStatuses(db, sent.sid)) ?? row;
    } catch (err) {
      console.error("sms accepted by twilio but local update failed", {
        messageId: row.id,
        sid: sent.sid,
        error: String(err),
      });
    }
  }

  await notify(
    c.env,
    ownerId,
    { type: "message", conversationId: conversation.id, messageId: row.id },
    c.executionCtx,
  );
  return c.json(
    { message: toThreadMessage(row), conversationId: conversation.id } satisfies SendSmsResult,
    201,
  );
});

function parseStatus(value: string) {
  const s = value?.toLowerCase();
  return s === "accepted" || s === "queued" || s === "sending" || s === "sent" || s === "failed" ? s : null;
}

const listQuery = z.object({
  numberId: z.string().max(64).optional(),
  cursor: z.string().max(200).optional(),
  q: z.string().trim().max(100).optional(),
});

messagesApi.get("/conversations", zValidator("query", listQuery, validationHook), async (c) => {
  const ownerId = c.get("user")!.id;
  const { numberId, cursor, q } = c.req.valid("query");
  const after = decodeCursor(cursor);
  const filters: (SQL | undefined)[] = [eq(conversations.ownerId, ownerId)];
  if (numberId) filters.push(eq(conversations.numberId, numberId));
  if (q) filters.push(or(escapeLike(sql`${conversations.participant}`, q), escapeLike(contactNameSql, q)));
  if (after)
    filters.push(or(lt(sortTime, after.at), and(eq(sortTime, after.at), lt(conversations.id, after.id))));
  const rows = await c
    .get("db")
    .select(conversationColumns)
    .from(conversations)
    .innerJoin(phoneNumbers, eq(phoneNumbers.id, conversations.numberId))
    .where(and(...filters))
    .orderBy(desc(sortTime), desc(conversations.id))
    .limit(PAGE_SIZE + 1)
    .all();
  const items = rows.slice(0, PAGE_SIZE).map(toListItem);
  const last = items[items.length - 1];
  const nextCursor = rows.length > PAGE_SIZE && last ? encodeCursor(last.lastMessageAt ?? 0, last.id) : null;
  return c.json({ items, nextCursor } satisfies Page<ConversationListItem>);
});

async function ownedConversation(c: Pick<Context<AppEnv>, "get">, id: string) {
  const ownerId = c.get("user")!.id;
  const row = await c
    .get("db")
    .select(conversationColumns)
    .from(conversations)
    .innerJoin(phoneNumbers, eq(phoneNumbers.id, conversations.numberId))
    .where(and(eq(conversations.id, id), eq(conversations.ownerId, ownerId)))
    .get();
  if (!row) throw new ApiError(404, "not_found", "Conversation not found");
  return row;
}

messagesApi.get("/conversations/:id", async (c) => {
  const row = await ownedConversation(c, c.req.param("id"));
  return c.json(toListItem(row));
});

const pageQuery = z.object({ cursor: z.string().max(200).optional() });

messagesApi.get("/conversations/:id/messages", zValidator("query", pageQuery, validationHook), async (c) => {
  const conversation = await ownedConversation(c, c.req.param("id"));
  const after = decodeCursor(c.req.valid("query").cursor);
  const filters: (SQL | undefined)[] = [eq(messages.conversationId, conversation.id)];
  if (after) {
    const at = new Date(after.at);
    filters.push(or(lt(messages.createdAt, at), and(eq(messages.createdAt, at), lt(messages.id, after.id))));
  }
  const rows = await c
    .get("db")
    .select()
    .from(messages)
    .where(and(...filters))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(PAGE_SIZE + 1)
    .all();
  const items = rows.slice(0, PAGE_SIZE).map(toThreadMessage);
  const last = items[items.length - 1];
  const nextCursor = rows.length > PAGE_SIZE && last ? encodeCursor(last.createdAt, last.id) : null;
  return c.json({ items, nextCursor } satisfies Page<ThreadMessage>);
});

messagesApi.post("/conversations/:id/read", async (c) => {
  const conversation = await ownedConversation(c, c.req.param("id"));
  if (conversation.unreadCount > 0) {
    await c
      .get("db")
      .update(conversations)
      .set({ unreadCount: 0 })
      .where(eq(conversations.id, conversation.id));
    await notify(
      c.env,
      c.get("user")!.id,
      { type: "conversation", conversationId: conversation.id },
      c.executionCtx,
    );
  }
  return c.json({ ok: true });
});

const searchQuery = z.object({ q: z.string().trim().min(1).max(100) });

messagesApi.get("/search", zValidator("query", searchQuery, validationHook), async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const { q } = c.req.valid("query");
  const found = await db
    .select({ message: messages, participant: conversations.participant, contactName: contactNameSql })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(messages.ownerId, ownerId), escapeLike(sql`${messages.body}`, q)))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(SEARCH_LIMIT)
    .all();
  const named = await db
    .select(conversationColumns)
    .from(conversations)
    .innerJoin(phoneNumbers, eq(phoneNumbers.id, conversations.numberId))
    .where(
      and(
        eq(conversations.ownerId, ownerId),
        or(escapeLike(contactNameSql, q), escapeLike(sql`${conversations.participant}`, q)),
      ),
    )
    .orderBy(desc(sortTime), desc(conversations.id))
    .limit(SEARCH_LIMIT)
    .all();
  return c.json({
    messages: found.map((r) => ({
      ...toThreadMessage(r.message),
      participant: r.participant,
      contactName: r.contactName,
    })),
    conversations: named.map(toListItem),
  } satisfies SearchResult);
});
