/**
 * Two-way SMS: storing messages, threading them into conversations, and applying Twilio status updates.
 * Used by the webhooks (routes/twilio-sms.ts), the owner API (routes/messages.ts) and the cron catch-up.
 *
 * Status rules: every status write goes through `nextMessageStatus` with a compare-and-set update, so two
 * callbacks racing each other can never move a message backwards. A status callback that arrives before the
 * send has stored the message SID stays unprocessed in webhook_events, and `applyPendingStatuses` replays it
 * once the SID is known.
 */
import { and, eq, inArray, isNull, like, lt, sql } from "drizzle-orm";
import { addressSchema } from "../../contracts";
import type { ThreadMessage } from "../../contracts/messages";
import { type MessageStatus, messageStatusSchema, nextMessageStatus } from "../../contracts/status";
import { createDb, type Db } from "../db";
import { contactNumbers, contacts, conversations, messages, webhookEvents } from "../db/schema";
import { notifyOwner as notify } from "./hub";
import { twilioRest } from "./twilio/rest";

export { notify };

type MessageRow = typeof messages.$inferSelect;

/** Statuses that count as "has left Twilio": the first time one is stored, sent_at is set. */
const SENT_STATUSES = new Set<MessageStatus>(["sent", "delivered", "undelivered", "read"]);

export const PREVIEW_MAX = 200;
export const PUSH_BODY_MAX = 120;

/** Who can text us: an E.164 number, a short code or an alphanumeric sender ID (stored as received). */
export const isSmsAddress = (value: string) => addressSchema.safeParse(value).success;

/** Parses a status string from Twilio. Unknown values (new Twilio statuses) give null and are not stored. */
export function parseMessageStatus(value: unknown): MessageStatus | null {
  const parsed = messageStatusSchema.safeParse(typeof value === "string" ? value.toLowerCase() : value);
  return parsed.success ? parsed.data : null;
}

/** Twilio's ErrorCode field as a number, or null when absent or not numeric. */
export function parseErrorCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string" || !/^\d{1,10}$/.test(value)) return null;
  return Number(value);
}

export function toThreadMessage(row: MessageRow): ThreadMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    twilioSid: row.twilioSid,
    direction: row.direction,
    from: row.from,
    to: row.to,
    body: row.body,
    status: row.status,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    clientId: row.clientId,
    media: row.media ?? null,
    sentAt: row.sentAt ? row.sentAt.getTime() : null,
    createdAt: row.createdAt.getTime(),
  };
}

/** The display name of the owner's contact for `address`, if one has that number. */
export async function contactNameFor(db: Db, ownerId: string, address: string): Promise<string | null> {
  const row = await db
    .select({ name: contacts.displayName })
    .from(contactNumbers)
    .innerJoin(contacts, eq(contacts.id, contactNumbers.contactId))
    .where(and(eq(contactNumbers.e164, address), eq(contacts.ownerId, ownerId)))
    .orderBy(contacts.displayName)
    .limit(1)
    .get();
  return row?.name ?? null;
}

/** The conversation for (our number, other party), created when it does not exist yet. */
export async function upsertConversation(db: Db, ownerId: string, numberId: string, participant: string) {
  await db.insert(conversations).values({ ownerId, numberId, participant }).onConflictDoNothing();
  const row = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.numberId, numberId), eq(conversations.participant, participant)))
    .get();
  if (!row || row.ownerId !== ownerId) throw new Error("conversation belongs to another owner");
  return row;
}

/**
 * Moves the conversation's "last message" forward to this message (never back to an older one) and, for an
 * inbound message, counts it as unread.
 */
export async function touchConversation(
  db: Db,
  conversationId: string,
  message: { createdAt: Date; body: string; direction: "inbound" | "outbound" },
) {
  const at = message.createdAt.getTime();
  const preview = message.body.slice(0, PREVIEW_MAX);
  await db
    .update(conversations)
    .set({
      lastMessagePreview: sql`CASE WHEN ${conversations.lastMessageAt} IS NULL OR ${conversations.lastMessageAt} <= ${at} THEN ${preview} ELSE ${conversations.lastMessagePreview} END`,
      lastMessageAt: sql`MAX(COALESCE(${conversations.lastMessageAt}, 0), ${at})`,
      unreadCount:
        message.direction === "inbound"
          ? sql`${conversations.unreadCount} + 1`
          : sql`${conversations.unreadCount}`,
    })
    .where(eq(conversations.id, conversationId));
}

/**
 * Applies a status (and an error code) to a stored message. Compare-and-set on the old status, retried a few
 * times, so concurrent callbacks settle on the furthest status. Returns the row after the write, or null when
 * the message does not exist.
 */
export async function applyMessageStatus(
  db: Db,
  where: { sid: string } | { id: string },
  incoming: MessageStatus,
  errorCode: number | null,
): Promise<{ row: MessageRow; changed: boolean } | null> {
  const match = "sid" in where ? eq(messages.twilioSid, where.sid) : eq(messages.id, where.id);
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await db.select().from(messages).where(match).get();
    if (!row) return null;
    const next = nextMessageStatus(row.status, incoming);
    const nextError = next === incoming && errorCode !== null ? errorCode : row.errorCode;
    if (next === row.status && nextError === row.errorCode) return { row, changed: false };
    const sentAt = row.sentAt ?? (SENT_STATUSES.has(next) ? new Date() : null);
    const updated = await db
      .update(messages)
      .set({ status: next, errorCode: nextError, sentAt })
      .where(and(eq(messages.id, row.id), eq(messages.status, row.status)))
      .returning()
      .get();
    if (updated) return { row: updated, changed: true };
  }
  throw new Error("message status kept changing under us");
}

const STATUS_KEY_PREFIX = "sms-status:";

/**
 * The webhook_events key for one status callback. The status and error code are part of the key so a
 * callback that beat the send response can be replayed from the key alone.
 */
export function statusEventKey(sid: string, status: MessageStatus, errorCode: number | null): string {
  return `${STATUS_KEY_PREFIX}${sid}:${status}${errorCode === null ? "" : `:${errorCode}`}`;
}

function parseStatusEventKey(key: string): { status: MessageStatus; errorCode: number | null } | null {
  const [, , status, code] = key.split(":");
  const parsed = parseMessageStatus(status);
  if (!parsed) return null;
  return { status: parsed, errorCode: code === undefined ? null : parseErrorCode(code) };
}

/** LIKE pattern matching `value` literally. */
export function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Replays status callbacks recorded for `sid` before its message row knew the SID. Call it right after the
 * send stores the SID. Returns the row when any status changed.
 */
export async function applyPendingStatuses(db: Db, sid: string): Promise<MessageRow | null> {
  const pending = await db
    .select({ id: webhookEvents.id, key: webhookEvents.idempotencyKey })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.type, "sms-status"),
        isNull(webhookEvents.processedAt),
        like(webhookEvents.idempotencyKey, `${likeEscape(`${STATUS_KEY_PREFIX}${sid}:`)}%`),
      ),
    )
    .all();
  let latest: MessageRow | null = null;
  for (const event of pending) {
    const parsed = parseStatusEventKey(event.key);
    if (!parsed) continue;
    const result = await applyMessageStatus(db, { sid }, parsed.status, parsed.errorCode);
    if (!result) return latest;
    if (result.changed) latest = result.row;
    await db.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, event.id));
  }
  return latest;
}

/** SHA-256 hex of a webhook payload, for webhook_events.payload_hash (never the payload itself). */
export async function payloadHash(params: Record<string, unknown>): Promise<string> {
  const text = JSON.stringify(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What Twilio's Message resource answers with (the fields we read). */
export type TwilioMessage = {
  sid: string;
  status: string;
  error_code: number | null;
  error_message: string | null;
};

const STUCK_STATUSES: MessageStatus[] = ["accepted", "queued", "sending"];
export const STUCK_AFTER_MS = 60 * 60 * 1000;
/** Messages older than this are left alone: Twilio keeps no useful state for them and it bounds the scan. */
export const STUCK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const STUCK_BATCH = 50;

/**
 * Cron job: outbound messages still accepted, queued or sending an hour after they were created probably
 * missed a status callback. Fetch each from Twilio and apply what it says. A row that never got a SID (the
 * send stopped between our insert and Twilio's answer) cannot be looked up, so it is marked failed.
 */
export async function refreshStuckMessages(
  env: Env,
  _ctx?: ExecutionContext,
  now = Date.now(),
): Promise<void> {
  const db = createDb(env.DB);
  const before = new Date(now - STUCK_AFTER_MS);
  const after = new Date(now - STUCK_MAX_AGE_MS);
  const stuck = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.direction, "outbound"),
        inArray(messages.status, STUCK_STATUSES),
        lt(messages.createdAt, before),
        sql`${messages.createdAt} >= ${after.getTime()}`,
      ),
    )
    .orderBy(messages.createdAt)
    .limit(STUCK_BATCH)
    .all();
  if (stuck.length === 0) return;
  const rest = twilioRest(env);
  for (const row of stuck) {
    if (!row.twilioSid) {
      const updated = await db
        .update(messages)
        .set({ status: "failed", errorMessage: "Sending did not finish" })
        .where(and(eq(messages.id, row.id), isNull(messages.twilioSid), eq(messages.status, row.status)))
        .returning()
        .get();
      if (updated)
        await notify(env, row.ownerId, {
          type: "message",
          conversationId: row.conversationId,
          messageId: row.id,
        });
      continue;
    }
    try {
      const remote = await rest.get<TwilioMessage>(`/Messages/${encodeURIComponent(row.twilioSid)}.json`);
      const status = parseMessageStatus(remote.status);
      if (!status) continue;
      const result = await applyMessageStatus(db, { id: row.id }, status, remote.error_code ?? null);
      if (result?.changed)
        await notify(env, row.ownerId, {
          type: "message",
          conversationId: row.conversationId,
          messageId: row.id,
        });
    } catch (err) {
      console.warn("sms refresh failed", { messageId: row.id, error: String(err) });
    }
  }
}
