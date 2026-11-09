/**
 * Twilio Messaging webhooks, mounted at /api/twilio/sms. The parent router has already checked
 * X-Twilio-Signature, so every request here came from Twilio with this account's auth token.
 *
 *   POST /inbound  the number's "A message comes in" URL. Stores the message and answers empty TwiML.
 *   POST /status   the StatusCallback of messages we send. Moves the stored status forward.
 *
 * Both record the delivery in webhook_events first (unique idempotency key), so Twilio's retries are
 * processed once.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { messages, phoneNumbers, webhookEvents } from "../db/schema";
import {
  applyMessageStatus,
  contactNameFor,
  isSmsAddress,
  notify,
  PUSH_BODY_MAX,
  parseErrorCode,
  parseMessageStatus,
  payloadHash,
  statusEventKey,
  touchConversation,
  upsertConversation,
} from "../lib/sms";
import type { AppEnv } from "../types";

export const twilioSms = new Hono<AppEnv>();

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
/** Twilio allows at most 10 media items per message. */
const MAX_MEDIA = 10;

const twiml = () =>
  new Response(EMPTY_TWIML, { status: 200, headers: { "content-type": "text/xml; charset=utf-8" } });

async function formOf(c: { req: { parseBody: () => Promise<Record<string, unknown>> } }) {
  const body = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
  return out;
}

/**
 * Records a webhook delivery. Returns "new" the first time, "pending" for a retry of one that never finished
 * processing, and "done" for a retry of one that did.
 */
async function recordEvent(
  db: AppEnv["Variables"]["db"],
  key: string,
  type: string,
  params: Record<string, string>,
): Promise<"new" | "pending" | "done"> {
  const inserted = await db
    .insert(webhookEvents)
    .values({ idempotencyKey: key, type, payloadHash: await payloadHash(params) })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id })
    .get();
  if (inserted) return "new";
  const existing = await db
    .update(webhookEvents)
    .set({ attempts: sql`${webhookEvents.attempts} + 1` })
    .where(eq(webhookEvents.idempotencyKey, key))
    .returning({ processedAt: webhookEvents.processedAt })
    .get();
  return existing?.processedAt ? "done" : "pending";
}

const markProcessed = (db: AppEnv["Variables"]["db"], key: string) =>
  db.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.idempotencyKey, key));

twilioSms.post("/inbound", async (c) => {
  const db = c.get("db");
  const p = await formOf(c);
  const sid = p.MessageSid ?? p.SmsMessageSid ?? p.SmsSid ?? "";
  const from = (p.From ?? "").trim();
  const to = (p.To ?? "").trim();
  if (!/^(SM|MM)[0-9a-f]{32}$/i.test(sid) || !isSmsAddress(from) || !to) {
    console.warn("sms inbound ignored", { reason: "missing fields", requestId: c.get("requestId") });
    return twiml();
  }

  const key = `sms-inbound:${sid}`;
  const state = await recordEvent(db, key, "sms-inbound", p);
  if (state === "done") return twiml();

  const number = await db
    .select({ id: phoneNumbers.id, ownerId: phoneNumbers.ownerId, e164: phoneNumbers.e164 })
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.e164, to), isNull(phoneNumbers.releasedAt)))
    .get();
  if (!number) {
    // Not one of ours (or released): nothing to store. Answer empty TwiML so Twilio does not retry.
    await markProcessed(db, key);
    return twiml();
  }

  const numMedia = Math.min(MAX_MEDIA, Math.max(0, Number.parseInt(p.NumMedia ?? "0", 10) || 0));
  const contentTypes: string[] = [];
  for (let i = 0; i < numMedia; i++) {
    const type = p[`MediaContentType${i}`];
    if (type) contentTypes.push(type.slice(0, 100));
  }
  const media = numMedia > 0 ? { count: numMedia, contentTypes } : null;
  const body = p.Body ?? "";

  const conversation = await upsertConversation(db, number.ownerId, number.id, from);
  const createdAt = new Date();
  const message = await db
    .insert(messages)
    .values({
      ownerId: number.ownerId,
      conversationId: conversation.id,
      twilioSid: sid,
      direction: "inbound",
      from,
      to: number.e164,
      body,
      status: "received",
      media,
      createdAt,
    })
    .onConflictDoNothing()
    .returning({ id: messages.id })
    .get();

  // A retry whose message row already exists (the first attempt stopped after the insert) must not count the
  // message as unread twice.
  if (message) await touchConversation(db, conversation.id, { createdAt, body, direction: "inbound" });
  await markProcessed(db, key);
  if (!message) return twiml();

  const name = await contactNameFor(db, number.ownerId, from);
  const text = body.trim() || (media ? "Attachment not saved" : "");
  await notify(
    c.env,
    number.ownerId,
    {
      type: "message",
      conversationId: conversation.id,
      messageId: message.id,
      push: {
        title: name ?? from,
        body: text.slice(0, PUSH_BODY_MAX),
        url: `/messages/${conversation.id}`,
        tag: `sms-${conversation.id}`,
      },
    },
    c.executionCtx,
  );
  return twiml();
});

twilioSms.post("/status", async (c) => {
  const db = c.get("db");
  const p = await formOf(c);
  const sid = p.MessageSid ?? p.SmsSid ?? "";
  const status = parseMessageStatus(p.MessageStatus ?? p.SmsStatus);
  const errorCode = parseErrorCode(p.ErrorCode);
  if (!/^(SM|MM)[0-9a-f]{32}$/i.test(sid) || !status) {
    console.warn("sms status ignored", { reason: "unknown status or sid", requestId: c.get("requestId") });
    return c.body(null, 204);
  }

  const key = statusEventKey(sid, status, errorCode);
  const state = await recordEvent(db, key, "sms-status", p);
  if (state === "done") return c.body(null, 204);

  const result = await applyMessageStatus(db, { sid }, status, errorCode);
  if (!result) {
    // The callback beat the send response: the row has no SID yet. The event stays unprocessed and the send
    // applies it once it stores the SID (applyPendingStatuses); the cron catch-up covers the rest.
    return c.body(null, 204);
  }
  await markProcessed(db, key);
  if (result.changed)
    await notify(
      c.env,
      result.row.ownerId,
      { type: "message", conversationId: result.row.conversationId, messageId: result.row.id },
      c.executionCtx,
    );
  return c.body(null, 204);
});
