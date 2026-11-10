// Talvuno's own tables. Every row is scoped by `owner_id` (the single owner today), so a later multi-user
// schema needs no data migration. Timestamps are epoch milliseconds, phone numbers are E.164 strings.
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { CALL_STATUSES, MESSAGE_STATUSES } from "../../../contracts/status";
import { user } from "./auth";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const ownerId = () =>
  text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" });
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());

const DIRECTIONS = ["inbound", "outbound"] as const;

/**
 * The owner's Twilio numbers. At most one default per owner (partial unique index). Rows are never deleted
 * while history points at them: set `released_at` instead.
 */
export const phoneNumbers = sqliteTable(
  "phone_numbers",
  {
    id: id(),
    ownerId: ownerId(),
    e164: text("e164").notNull().unique(),
    twilioSid: text("twilio_sid").notNull().unique(),
    friendlyName: text("friendly_name").notNull().default(""),
    capabilities: text("capabilities", { mode: "json" })
      .$type<{ voice: boolean; sms: boolean; mms: boolean }>()
      .notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    // Removing a number is a soft delete: its conversations and calls keep pointing at the row.
    releasedAt: integer("released_at", { mode: "timestamp_ms" }),
    // Why it was released: 'owner' removals survive a sync, 'twilio' ones are revived when Twilio lists the number again.
    releasedReason: text("released_reason", { enum: ["owner", "twilio"] }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("phone_numbers_owner_idx").on(t.ownerId),
    uniqueIndex("phone_numbers_one_default_idx").on(t.ownerId).where(sql`is_default = 1`),
  ],
);

export const contacts = sqliteTable(
  "contacts",
  {
    id: id(),
    ownerId: ownerId(),
    displayName: text("display_name").notNull(),
    /** nameSortKey(displayName) from src/lib/sort-key.ts: the list order and name search use it. */
    sortKey: text("sort_key").notNull().default(""),
    company: text("company"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("contacts_owner_sort_key_idx").on(t.ownerId, t.sortKey, t.id)],
);

export const contactNumbers = sqliteTable(
  "contact_numbers",
  {
    id: id(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    e164: text("e164").notNull(),
    label: text("label"),
  },
  (t) => [
    // Caller resolution looks numbers up by E.164.
    index("contact_numbers_e164_idx").on(t.e164),
    uniqueIndex("contact_numbers_contact_e164_idx").on(t.contactId, t.e164),
  ],
);

/** One thread per (our number, other party). */
export const conversations = sqliteTable(
  "conversations",
  {
    id: id(),
    ownerId: ownerId(),
    numberId: text("number_id")
      .notNull()
      .references(() => phoneNumbers.id, { onDelete: "restrict" }),
    participant: text("participant").notNull(),
    lastMessageAt: integer("last_message_at", { mode: "timestamp_ms" }),
    lastMessagePreview: text("last_message_preview"),
    unreadCount: integer("unread_count").notNull().default(0),
    // Pinned threads sit above the rest, newest pin first. Archived threads leave the main list until a new message arrives.
    pinnedAt: integer("pinned_at", { mode: "timestamp_ms" }),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    // The owner marked the thread unread by hand. Opening the thread clears it.
    markedUnread: integer("marked_unread", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("conversations_number_participant_idx").on(t.numberId, t.participant),
    index("conversations_owner_last_idx").on(t.ownerId, t.lastMessageAt),
    index("conversations_participant_idx").on(t.participant),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: id(),
    ownerId: ownerId(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "restrict" }),
    // Null only between inserting an outbound row and Twilio answering with its SID. SQLite allows many NULLs.
    twilioSid: text("twilio_sid").unique(),
    direction: text("direction", { enum: DIRECTIONS }).notNull(),
    from: text("from").notNull(),
    to: text("to").notNull(),
    body: text("body").notNull().default(""),
    status: text("status", { enum: MESSAGE_STATUSES }).notNull(),
    errorCode: integer("error_code"),
    // A plain reason shown next to a failed outbound message (Twilio's error text, never a secret).
    errorMessage: text("error_message"),
    // Outbound only: the browser's id for this send, so a repeated POST never sends twice.
    clientId: text("client_id"),
    // Inbound MMS is not saved; this records that media arrived (count and content types only).
    media: text("media", { mode: "json" }).$type<{ count: number; contentTypes: string[] }>(),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The id breaks ties between messages created in the same millisecond, so keyset pagination is stable.
    index("messages_conversation_created_idx").on(t.conversationId, t.createdAt, t.id),
    index("messages_owner_created_idx").on(t.ownerId, t.createdAt),
    uniqueIndex("messages_owner_client_id_idx").on(t.ownerId, t.clientId),
  ],
);

export const calls = sqliteTable(
  "calls",
  {
    id: id(),
    ownerId: ownerId(),
    twilioCallSid: text("twilio_call_sid").notNull().unique(),
    parentCallSid: text("parent_call_sid"),
    direction: text("direction", { enum: DIRECTIONS }).notNull(),
    numberId: text("number_id").references(() => phoneNumbers.id, { onDelete: "restrict" }),
    party: text("party").notNull(),
    status: text("status", { enum: CALL_STATUSES }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    answeredAt: integer("answered_at", { mode: "timestamp_ms" }),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    duration: integer("duration"),
    /** Twilio's error code for a call that failed to connect (for example 13227), and its short message. */
    errorCode: integer("error_code"),
    errorMessage: text("error_message"),
    contactId: text("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("calls_owner_started_idx").on(t.ownerId, t.startedAt),
    index("calls_parent_idx").on(t.parentCallSid),
    index("calls_party_idx").on(t.party),
  ],
);

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: id(),
    ownerId: ownerId(),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("push_subscriptions_owner_idx").on(t.ownerId)],
);

/**
 * Every Twilio webhook is recorded here before it is processed. The idempotency key (for example
 * "sms-status:SMxxx:delivered") is unique, so a retried delivery is recognised and skipped.
 */
export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    id: id(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    type: text("type").notNull(),
    receivedAt: integer("received_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    processedAt: integer("processed_at", { mode: "timestamp_ms" }),
    payloadHash: text("payload_hash").notNull(),
    attempts: integer("attempts").notNull().default(1),
    lastError: text("last_error"),
  },
  (t) => [index("webhook_events_received_idx").on(t.receivedAt)],
);

export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  defaultNumberId: text("default_number_id").references(() => phoneNumbers.id, { onDelete: "set null" }),
  // ISO 3166-1 alpha-2 codes the owner may call or text. Empty allows nothing.
  countryAllowlist: text("country_allowlist", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  locale: text("locale").notNull().default("en"),
  theme: text("theme", { enum: ["system", "light", "dark"] })
    .notNull()
    .default("system"),
  smsPerHour: integer("sms_per_hour").notNull().default(30),
  callsPerHour: integer("calls_per_hour").notNull().default(20),
  // Morning digest: off by default. `digest_time` is HH:MM in the IANA zone `timezone`.
  digestEnabled: integer("digest_enabled", { mode: "boolean" }).notNull().default(false),
  digestTime: text("digest_time").notNull().default("08:00"),
  timezone: text("timezone").notNull().default("UTC"),
  // Local date (YYYY-MM-DD in `timezone`) of the last digest, and when it went, so a day sends once and
  // the next digest counts from there.
  lastDigestDate: text("last_digest_date"),
  lastDigestAt: integer("last_digest_at", { mode: "timestamp_ms" }),
  updatedAt: updatedAt(),
});

/** Costs Twilio reports back (message price, call price), for the usage view and spend guards. */
export const spendEvents = sqliteTable(
  "spend_events",
  {
    id: id(),
    ownerId: ownerId(),
    kind: text("kind", { enum: ["sms", "call"] }).notNull(),
    twilioSid: text("twilio_sid").notNull().unique(),
    // Twilio's price is a decimal string ("-0.00790"); kept as text so no float rounding creeps in.
    price: text("price"),
    priceUnit: text("price_unit"),
    units: integer("units"),
    createdAt: createdAt(),
  },
  (t) => [index("spend_events_owner_created_idx").on(t.ownerId, t.createdAt)],
);

/** Security-significant actions. Metadata never holds message bodies or secrets. */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: id(),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
    actor: text("actor", { enum: ["owner", "system", "twilio"] }).notNull(),
    action: text("action").notNull(),
    target: text("target"),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_events_owner_created_idx").on(t.ownerId, t.createdAt)],
);

/** Saved short replies for the composer and "decline with text". Shown in `sort_order`, then creation order. */
export const quickReplies = sqliteTable(
  "quick_replies",
  {
    id: id(),
    ownerId: ownerId(),
    text: text("text").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("quick_replies_owner_sort_idx").on(t.ownerId, t.sortOrder)],
);

/** One row per owner once the default quick replies were added, so deleting them all does not bring them back. */
export const quickReplyState = sqliteTable("quick_reply_state", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  seededAt: integer("seeded_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** The automatic text after a missed call, per number. Off by default: a number without a row sends nothing. */
export const missedCallSettings = sqliteTable("missed_call_settings", {
  numberId: text("number_id")
    .primaryKey()
    .references(() => phoneNumbers.id, { onDelete: "cascade" }),
  ownerId: ownerId(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  text: text("text").notNull().default(""),
  updatedAt: updatedAt(),
});

/** Which callers already got the missed-call text today (UTC day). The unique key makes "once a day" atomic. */
export const missedCallTexts = sqliteTable(
  "missed_call_texts",
  {
    id: id(),
    ownerId: ownerId(),
    numberId: text("number_id")
      .notNull()
      .references(() => phoneNumbers.id, { onDelete: "cascade" }),
    caller: text("caller").notNull(),
    day: text("day").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("missed_call_texts_number_caller_day_idx").on(t.numberId, t.caller, t.day)],
);
