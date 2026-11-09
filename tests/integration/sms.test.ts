import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cronJobs } from "../../src/worker/cron";
import { refreshStuckMessages, STUCK_AFTER_MS } from "../../src/worker/lib/sms";
import { PAGE_SIZE } from "../../src/worker/routes/messages";
import { createOwner, resetDb } from "./helpers";
import { signedTwilioPost } from "./twilio-helpers";

const OUR = "+14155550100";
const OTHER = "+14155550111";
const PEER = "+14155552671";
const sid = (n: number) => `SM${n.toString(16).padStart(32, "0")}`;

let twilioCalls: { url: string; method: string; body: string }[] = [];
let twilioAnswer: (url: string, body: string) => Response = () =>
  Response.json({ sid: sid(999), status: "queued" }, { status: 201 });

beforeEach(async () => {
  await resetDb();
  twilioCalls = [];
  twilioAnswer = () => Response.json({ sid: sid(999), status: "queued" }, { status: 201 });
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith("https://twilio.mock/")) return real(input, init);
    const body = typeof init?.body === "string" ? init.body : "";
    twilioCalls.push({ url, method: init?.method ?? "GET", body });
    return twilioAnswer(url, body);
  });
});
afterEach(() => vi.restoreAllMocks());

async function addNumber(ownerId: string, e164 = OUR, released = false) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO phone_numbers (id, owner_id, e164, twilio_sid, friendly_name, capabilities, is_default, released_at, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, 0, ?, ?, ?)",
  )
    .bind(
      id,
      ownerId,
      e164,
      `PN${crypto.randomUUID().replace(/-/g, "")}`,
      JSON.stringify({ voice: true, sms: true, mms: false }),
      released ? Date.now() : null,
      Date.now(),
      Date.now(),
    )
    .run();
  return id;
}

async function allowUS(ownerId: string, smsPerHour = 30) {
  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, country_allowlist, sms_per_hour, calls_per_hour, updated_at) VALUES (?, '["US"]', ?, 20, ?)
     ON CONFLICT(user_id) DO UPDATE SET country_allowlist = excluded.country_allowlist, sms_per_hour = excluded.sms_per_hour`,
  )
    .bind(ownerId, smsPerHour, Date.now())
    .run();
}

const inbound = (n: number, extra: Record<string, string> = {}) =>
  signedTwilioPost("/api/twilio/sms/inbound", {
    MessageSid: sid(n),
    AccountSid: "AC00000000000000000000000000000000",
    From: PEER,
    To: OUR,
    Body: `hello ${n}`,
    NumMedia: "0",
    ...extra,
  });

const statusCallback = (s: string, status: string, extra: Record<string, string> = {}) =>
  signedTwilioPost("/api/twilio/sms/status", { MessageSid: s, MessageStatus: status, ...extra });

const rows = async (sql: string, ...binds: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...binds)
      .all<Record<string, unknown>>()
  ).results;

describe("inbound SMS webhook", () => {
  it("stores the message, threads it and counts it unread, once per MessageSid", async () => {
    const { userId } = await createOwner();
    await addNumber(userId);
    const res = await inbound(1);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    expect(await res.text()).toContain("<Response/>");
    // Twilio retries the same delivery.
    expect((await inbound(1)).status).toBe(200);
    await inbound(2);
    const msgs = await rows("SELECT * FROM messages ORDER BY twilio_sid");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({
      direction: "inbound",
      from: PEER,
      to: OUR,
      body: "hello 1",
      status: "received",
    });
    const convs = await rows("SELECT * FROM conversations");
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ participant: PEER, unread_count: 2, last_message_preview: "hello 2" });
    const events = await rows(
      "SELECT * FROM webhook_events WHERE type = 'sms-inbound' ORDER BY idempotency_key",
    );
    expect(events).toHaveLength(2);
    expect(events[0]!.attempts).toBe(2);
  });

  it("ignores messages to a number that is not ours or was released", async () => {
    const { userId } = await createOwner();
    await addNumber(userId, OTHER, true);
    expect(await (await inbound(1)).text()).toContain("<Response/>");
    expect(await (await inbound(2, { To: OTHER })).text()).toContain("<Response/>");
    expect(await rows("SELECT id FROM messages")).toHaveLength(0);
  });

  it("accepts short code and alphanumeric senders as their own threads", async () => {
    const { userId } = await createOwner();
    await addNumber(userId);
    await inbound(1, { From: "72345" });
    await inbound(2, { From: "MyBank" });
    const convs = await rows("SELECT participant FROM conversations ORDER BY participant");
    expect(convs.map((c) => c.participant)).toEqual(["72345", "MyBank"]);
  });

  it("records that media arrived without fetching it", async () => {
    const { userId } = await createOwner();
    await addNumber(userId);
    await inbound(1, {
      Body: "",
      NumMedia: "2",
      MediaContentType0: "image/jpeg",
      MediaContentType1: "image/png",
      MediaUrl0: "https://x",
    });
    const [msg] = await rows("SELECT media FROM messages");
    expect(JSON.parse(String(msg!.media))).toEqual({ count: 2, contentTypes: ["image/jpeg", "image/png"] });
    expect(twilioCalls).toHaveLength(0);
  });

  it("refuses unsigned requests", async () => {
    const res = await signedTwilioPost(
      "/api/twilio/sms/inbound",
      { MessageSid: sid(1) },
      { signature: null },
    );
    expect(res.status).toBe(403);
  });
});

describe("sending", () => {
  async function ready(smsPerHour = 30) {
    const s = await createOwner();
    await allowUS(s.userId, smsPerHour);
    const numberId = await addNumber(s.userId);
    return { s, numberId };
  }

  it("stores, sends with the status callback, and keeps the SID", async () => {
    const { s, numberId } = await ready();
    const out = await s.post(
      "/api/messages/send",
      { numberId, to: "(415) 555-2671", body: "hi", clientId: crypto.randomUUID() },
      400,
    );
    expect(out.error).toBe("invalid_number");
    const sent = await s.post(
      "/api/messages/send",
      { numberId, to: PEER, body: "hi there", clientId: crypto.randomUUID() },
      201,
    );
    expect(sent.message).toMatchObject({
      twilioSid: sid(999),
      status: "queued",
      direction: "outbound",
      to: PEER,
      from: OUR,
    });
    expect(twilioCalls).toHaveLength(1);
    expect(twilioCalls[0]!.url).toBe(
      "https://twilio.mock/2010-04-01/Accounts/AC00000000000000000000000000000000/Messages.json",
    );
    const form = new URLSearchParams(twilioCalls[0]!.body);
    expect(Object.fromEntries(form)).toEqual({
      From: OUR,
      To: PEER,
      Body: "hi there",
      StatusCallback: "https://talvuno.test/api/twilio/sms/status",
    });
    const [conv] = await rows("SELECT * FROM conversations");
    expect(conv).toMatchObject({ participant: PEER, unread_count: 0, last_message_preview: "hi there" });
  });

  it("keeps a message Twilio accepted out of the failed state when the local update throws", async () => {
    const { s, numberId } = await ready();
    await env.DB.prepare(
      "CREATE TRIGGER fail_sid_update BEFORE UPDATE OF twilio_sid ON messages BEGIN SELECT RAISE(ABORT, 'injected'); END",
    ).run();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let sent!: { message: { status: string } };
    try {
      sent = await s.post(
        "/api/messages/send",
        { numberId, to: PEER, body: "accepted", clientId: crypto.randomUUID() },
        201,
      );
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_sid_update").run();
    }
    expect(twilioCalls).toHaveLength(1);
    expect(sent.message.status).toBe("queued");
    const [row] = await rows("SELECT status, error_code, error_message FROM messages");
    expect(row).toMatchObject({ status: "queued", error_code: null, error_message: null });
    expect(JSON.stringify(errors.mock.calls)).toContain(sid(999));
  });

  it("never sends the same clientId twice", async () => {
    const { s, numberId } = await ready();
    const clientId = crypto.randomUUID();
    const first = await s.post("/api/messages/send", { numberId, to: PEER, body: "once", clientId }, 201);
    const again = await s.post("/api/messages/send", { numberId, to: PEER, body: "once", clientId }, 200);
    expect(again.message.id).toBe(first.message.id);
    expect(twilioCalls).toHaveLength(1);
    expect(await rows("SELECT id FROM messages")).toHaveLength(1);
  });

  it("marks the message failed with Twilio's code and text", async () => {
    const { s, numberId } = await ready();
    twilioAnswer = () =>
      Response.json(
        { code: 21610, message: "Attempt to send to unsubscribed recipient", more_info: "x", status: 400 },
        { status: 400 },
      );
    const out = await s.post(
      "/api/messages/send",
      { numberId, to: PEER, body: "hi", clientId: crypto.randomUUID() },
      201,
    );
    expect(out.message).toMatchObject({
      status: "failed",
      errorCode: 21610,
      errorMessage: "Attempt to send to unsubscribed recipient",
      twilioSid: null,
    });
  });

  it("refuses a country outside the allowlist, a released number and a full hourly budget", async () => {
    const { s, numberId } = await ready(1);
    const uk = await s.post(
      "/api/messages/send",
      { numberId, to: "+447911123456", body: "hi", clientId: crypto.randomUUID() },
      403,
    );
    expect(uk.error).toBe("country_not_allowed");
    const released = await addNumber(s.userId, OTHER, true);
    await s.post(
      "/api/messages/send",
      { numberId: released, to: PEER, body: "hi", clientId: crypto.randomUUID() },
      404,
    );
    await s.post(
      "/api/messages/send",
      { numberId, to: PEER, body: "hi", clientId: crypto.randomUUID() },
      201,
    );
    const limited = await s.post(
      "/api/messages/send",
      { numberId, to: PEER, body: "hi", clientId: crypto.randomUUID() },
      429,
    );
    expect(limited.error).toBe("rate_limited");
    expect(twilioCalls).toHaveLength(1);
    expect(await rows("SELECT id FROM messages")).toHaveLength(1);
  });

  it("validates the body length", async () => {
    const { s, numberId } = await ready();
    await s.post("/api/messages/send", { numberId, to: PEER, body: "", clientId: crypto.randomUUID() }, 400);
    await s.post(
      "/api/messages/send",
      { numberId, to: PEER, body: "x".repeat(1601), clientId: crypto.randomUUID() },
      400,
    );
    expect(twilioCalls).toHaveLength(0);
  });
});

describe("status callbacks", () => {
  async function sentMessage() {
    const s = await createOwner();
    await allowUS(s.userId);
    const numberId = await addNumber(s.userId);
    const out = await s.post(
      "/api/messages/send",
      { numberId, to: PEER, body: "hi", clientId: crypto.randomUUID() },
      201,
    );
    return { s, id: out.message.id as string };
  }
  const statusOf = async (id: string) =>
    (await rows("SELECT status, error_code FROM messages WHERE id = ?", id))[0];

  it("only moves forward when callbacks arrive out of order, and replays are harmless", async () => {
    const { id } = await sentMessage();
    expect((await statusCallback(sid(999), "delivered")).status).toBe(204);
    await statusCallback(sid(999), "sent");
    await statusCallback(sid(999), "sending");
    await statusCallback(sid(999), "delivered");
    expect(await statusOf(id)).toEqual({ status: "delivered", error_code: null });
  });

  it("stores the error code of an undelivered message", async () => {
    const { id } = await sentMessage();
    await statusCallback(sid(999), "undelivered", { ErrorCode: "30003" });
    expect(await statusOf(id)).toEqual({ status: "undelivered", error_code: 30003 });
  });

  it("keeps a callback that beat the send response and applies it when the SID is stored", async () => {
    const s = await createOwner();
    await allowUS(s.userId);
    const numberId = await addNumber(s.userId);
    // Twilio answers the create call only after its "sent" and "delivered" callbacks have reached us.
    twilioAnswer = () => Response.json({ sid: sid(999), status: "queued" }, { status: 201 });
    await statusCallback(sid(999), "sent");
    await statusCallback(sid(999), "delivered");
    const pending = await rows("SELECT processed_at FROM webhook_events WHERE type = 'sms-status'");
    expect(pending).toHaveLength(2);
    expect(pending.every((e) => e.processed_at === null)).toBe(true);
    const out = await s.post(
      "/api/messages/send",
      { numberId, to: PEER, body: "hi", clientId: crypto.randomUUID() },
      201,
    );
    expect(out.message.status).toBe("delivered");
    const done = await rows("SELECT processed_at FROM webhook_events WHERE type = 'sms-status'");
    expect(done.every((e) => e.processed_at !== null)).toBe(true);
  });

  it("ignores statuses it does not know", async () => {
    const { id } = await sentMessage();
    expect((await statusCallback(sid(999), "teleported")).status).toBe(204);
    expect((await statusOf(id))!.status).toBe("queued");
  });
});

describe("conversations API", () => {
  it("lists threads newest first with contact names, paginates and searches", async () => {
    const s = await createOwner();
    await addNumber(s.userId);
    const contactId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO contacts (id, owner_id, display_name, created_at, updated_at) VALUES (?, ?, 'Ada Lovelace', ?, ?)",
    )
      .bind(contactId, s.userId, Date.now(), Date.now())
      .run();
    await env.DB.prepare("INSERT INTO contact_numbers (id, contact_id, e164) VALUES (?, ?, ?)")
      .bind(crypto.randomUUID(), contactId, PEER)
      .run();
    const total = PAGE_SIZE + 3;
    for (let i = 0; i < total; i++) await inbound(i + 1, { From: `+1415555${(3000 + i).toString()}` });
    await inbound(500, { From: PEER, Body: "the secret word is turnip" });

    const first = await s.get("/api/messages/conversations");
    expect(first.items).toHaveLength(PAGE_SIZE);
    expect(first.items[0]).toMatchObject({ participant: PEER, contactName: "Ada Lovelace", unreadCount: 1 });
    expect(first.nextCursor).toBeTruthy();
    const second = await s.get(`/api/messages/conversations?cursor=${encodeURIComponent(first.nextCursor)}`);
    expect(second.items).toHaveLength(total + 1 - PAGE_SIZE);
    expect(second.nextCursor).toBeNull();
    const ids = new Set([...first.items, ...second.items].map((c: { id: string }) => c.id));
    expect(ids.size).toBe(total + 1);

    const byName = await s.get("/api/messages/conversations?q=ada");
    expect(byName.items.map((c: { participant: string }) => c.participant)).toEqual([PEER]);

    const found = await s.get("/api/messages/search?q=turnip");
    expect(found.messages).toHaveLength(1);
    expect(found.messages[0]).toMatchObject({ participant: PEER, contactName: "Ada Lovelace" });
    expect((await s.get("/api/messages/search?q=lovelace")).conversations).toHaveLength(1);
    expect((await s.get("/api/messages/search?q=%25")).messages).toHaveLength(0);
  });

  it("pages a thread newest first and marks it read", async () => {
    const s = await createOwner();
    await addNumber(s.userId);
    for (let i = 1; i <= PAGE_SIZE + 5; i++) await inbound(i);
    const { items } = await s.get("/api/messages/conversations");
    const id = items[0].id;
    const page1 = await s.get(`/api/messages/conversations/${id}/messages`);
    expect(page1.items).toHaveLength(PAGE_SIZE);
    expect(page1.items[0].body).toBe(`hello ${PAGE_SIZE + 5}`);
    const page2 = await s.get(
      `/api/messages/conversations/${id}/messages?cursor=${encodeURIComponent(page1.nextCursor)}`,
    );
    expect(page2.items.map((m: { body: string }) => m.body)).toEqual(
      [5, 4, 3, 2, 1].map((n) => `hello ${n}`),
    );
    expect(page2.nextCursor).toBeNull();
    await s.post(`/api/messages/conversations/${id}/read`);
    expect((await s.get(`/api/messages/conversations/${id}`)).unreadCount).toBe(0);
  });

  it("does not show another owner's thread and needs a session", async () => {
    const s = await createOwner();
    const otherId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      'INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
    )
      .bind(otherId, "Other", "other@example.com", now, now)
      .run();
    const otherNumber = await addNumber(otherId, OTHER);
    const convId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO conversations (id, owner_id, number_id, participant, unread_count, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
    )
      .bind(convId, otherId, otherNumber, PEER, now, now)
      .run();
    await s.get(`/api/messages/conversations/${convId}`, 404);
    await s.get(`/api/messages/conversations/${convId}/messages`, 404);
    const res = await new (s.constructor as new () => typeof s)().fetch("/api/messages/conversations");
    expect(res.status).toBe(401);
  });
});

describe("stuck message refresh", () => {
  it("is a cron job that refreshes old queued messages from Twilio and fails ones without a SID", async () => {
    expect(cronJobs).toContain(refreshStuckMessages);
    const s = await createOwner();
    await allowUS(s.userId);
    const numberId = await addNumber(s.userId);
    const a = await s.post(
      "/api/messages/send",
      { numberId, to: PEER, body: "a", clientId: crypto.randomUUID() },
      201,
    );
    const old = Date.now() - STUCK_AFTER_MS - 60_000;
    await env.DB.prepare("UPDATE messages SET created_at = ?").bind(old).run();
    const noSid = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO messages (id, owner_id, conversation_id, direction, \"from\", \"to\", body, status, created_at, updated_at) VALUES (?, ?, ?, 'outbound', ?, ?, 'b', 'queued', ?, ?)",
    )
      .bind(noSid, s.userId, a.conversationId, OUR, PEER, old, old)
      .run();
    twilioCalls = [];
    twilioAnswer = () =>
      Response.json({ sid: sid(999), status: "delivered", error_code: null, error_message: null });
    await refreshStuckMessages(env);
    expect(twilioCalls.map((t) => t.url)).toEqual([
      `https://twilio.mock/2010-04-01/Accounts/AC00000000000000000000000000000000/Messages/${sid(999)}.json`,
    ]);
    const byId = Object.fromEntries(
      (await rows("SELECT id, status FROM messages")).map((r) => [r.id, r.status]),
    );
    expect(byId).toEqual({ [a.message.id]: "delivered", [noSid]: "failed" });
    // Fresh messages are left alone.
    twilioCalls = [];
    await refreshStuckMessages(env);
    expect(twilioCalls).toHaveLength(0);
  });
});
