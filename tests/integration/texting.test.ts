import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../../src/worker/db";
import { dayKey } from "../../src/worker/lib/missed-call";
import { applyCallEvent } from "../../src/worker/lib/voice/calls";
import { DEFAULT_QUICK_REPLIES } from "../../src/worker/routes/quick-replies";
import { createOwner, resetDb } from "./helpers";

const OUR = "+14155550100";
const PEER = "+14155552671";
const PEER2 = "+14155552672";

let twilioCalls: { url: string; body: string }[] = [];
let twilioStatus = 201;

beforeEach(async () => {
  await resetDb();
  twilioCalls = [];
  twilioStatus = 201;
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith("https://twilio.mock/")) return real(input, init);
    twilioCalls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    if (twilioStatus !== 201) return Response.json({ code: 21211, message: "bad" }, { status: twilioStatus });
    return Response.json(
      { sid: `SM${twilioCalls.length.toString(16).padStart(32, "0")}`, status: "queued" },
      { status: 201 },
    );
  });
});
afterEach(() => vi.restoreAllMocks());

const rows = async (sql: string, ...binds: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...binds)
      .all<Record<string, unknown>>()
  ).results;

async function addNumber(ownerId: string, e164 = OUR) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO phone_numbers (id, owner_id, e164, twilio_sid, friendly_name, capabilities, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, 0, ?, ?)",
  )
    .bind(
      id,
      ownerId,
      e164,
      `PN${crypto.randomUUID().replace(/-/g, "")}`,
      JSON.stringify({ voice: true, sms: true, mms: false }),
      Date.now(),
      Date.now(),
    )
    .run();
  return id;
}

async function allow(ownerId: string, countries = '["US"]', smsPerHour = 30) {
  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, country_allowlist, sms_per_hour, calls_per_hour, updated_at) VALUES (?, ?, ?, 20, ?)
     ON CONFLICT(user_id) DO UPDATE SET country_allowlist = excluded.country_allowlist, sms_per_hour = excluded.sms_per_hour`,
  )
    .bind(ownerId, countries, smsPerHour, Date.now())
    .run();
}

async function ready() {
  const s = await createOwner();
  await allow(s.userId);
  const numberId = await addNumber(s.userId);
  return { s, numberId };
}

describe("quick replies API", () => {
  it("requires a session", async () => {
    const { Session } = await import("./helpers");
    expect((await new Session().fetch("/api/quick-replies")).status).toBe(401);
  });

  it("adds the three defaults on the first read, once", async () => {
    const { s } = await ready();
    const first = await s.get("/api/quick-replies");
    expect(first.map((r: { text: string }) => r.text)).toEqual([...DEFAULT_QUICK_REPLIES]);
    for (const r of first) await s.json("DELETE", `/api/quick-replies/${r.id}`);
    expect(await s.get("/api/quick-replies")).toEqual([]);
  });

  it("adds, edits, orders and removes replies, and checks the text", async () => {
    const { s } = await ready();
    await s.get("/api/quick-replies");
    const added = await s.post("/api/quick-replies", { text: "  At lunch  " }, 201);
    expect(added).toMatchObject({ text: "At lunch", sortOrder: 3 });
    await s.post("/api/quick-replies", { text: "" }, 400);
    await s.post("/api/quick-replies", { text: "x".repeat(161) }, 400);
    const edited = await s.json("PATCH", `/api/quick-replies/${added.id}`, { text: "At lunch, back at 2" });
    expect(edited.text).toBe("At lunch, back at 2");
    const before = await s.get("/api/quick-replies");
    await s.json("PATCH", `/api/quick-replies/${before[0].id}`, { sortOrder: 10 });
    const list = await s.get("/api/quick-replies");
    expect(list.at(-1).id).toBe(before[0].id);
    await s.json("DELETE", `/api/quick-replies/${added.id}`);
    expect((await s.get("/api/quick-replies")).some((r: { id: string }) => r.id === added.id)).toBe(false);
    await s.json("DELETE", `/api/quick-replies/${added.id}`, undefined, 404);
  });

  it("never shows or changes another owner's replies", async () => {
    const { s } = await ready();
    await env.DB.prepare(
      "INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('other', 'Other', 'other@talvuno.test', ?, ?)",
    )
      .bind(Date.now(), Date.now())
      .run();
    await env.DB.prepare(
      "INSERT INTO quick_replies (id, owner_id, text, sort_order, created_at, updated_at) VALUES ('theirs', 'other', 'secret', 0, ?, ?)",
    )
      .bind(Date.now(), Date.now())
      .run();
    const list = await s.get("/api/quick-replies");
    expect(list.some((r: { id: string }) => r.id === "theirs")).toBe(false);
    await s.json("PATCH", "/api/quick-replies/theirs", { text: "mine now" }, 404);
    await s.json("DELETE", "/api/quick-replies/theirs", undefined, 404);
    expect((await rows("SELECT text FROM quick_replies WHERE id = 'theirs'"))[0]!.text).toBe("secret");
  });
});

describe("decline with text, server side", () => {
  // The sheet rejects the call and sends through the ordinary send endpoint, from the number that was called.
  it("sends the picked reply to the caller from the called number", async () => {
    const { s, numberId } = await ready();
    const sent = await s.post(
      "/api/messages/send",
      { numberId, to: PEER, body: "Can I call you back?", clientId: crypto.randomUUID() },
      201,
    );
    expect(sent.message).toMatchObject({ from: OUR, to: PEER, direction: "outbound" });
    expect(Object.fromEntries(new URLSearchParams(twilioCalls[0]!.body))).toMatchObject({
      From: OUR,
      To: PEER,
      Body: "Can I call you back?",
    });
  });

  it("is still refused by the contact guards", async () => {
    const { s, numberId } = await ready();
    await allow(s.userId, '["GB"]');
    const refused = await s.post(
      "/api/messages/send",
      { numberId, to: PEER, body: "hi", clientId: crypto.randomUUID() },
      403,
    );
    expect(refused.error).toBe("country_not_allowed");
    expect(twilioCalls).toHaveLength(0);
  });
});

describe("missed-call text", () => {
  async function missedCall(ownerId: string, numberId: string, party: string) {
    const sid = `CA${crypto.randomUUID().replace(/-/g, "")}`;
    await env.DB.prepare(
      "INSERT INTO calls (id, owner_id, twilio_call_sid, direction, number_id, party, status, started_at, created_at, updated_at) VALUES (?, ?, ?, 'inbound', ?, ?, 'ringing', ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), ownerId, sid, numberId, party, Date.now(), Date.now(), Date.now())
      .run();
    // The parent leg ending unanswered is what makes an inbound call missed.
    await applyCallEvent(env, createDb(env.DB), sid, { leg: "parent", status: "no-answer", at: new Date() });
  }

  const enable = (s: Awaited<ReturnType<typeof createOwner>>, numberId: string, text = "Sorry, missed you") =>
    s.json("PUT", `/api/missed-call-text/${numberId}`, { enabled: true, text });

  it("is off by default and lists every number with the default text", async () => {
    const { s, numberId } = await ready();
    const list = await s.get("/api/missed-call-text");
    expect(list).toMatchObject([{ numberId, enabled: false }]);
    expect(list[0].text.length).toBeGreaterThan(0);
    await missedCall(s.userId, numberId, PEER);
    expect(twilioCalls).toHaveLength(0);
  });

  it("scopes the setting to the owner's own numbers and needs text to turn on", async () => {
    const { s, numberId } = await ready();
    await s.json("PUT", "/api/missed-call-text/not-mine", { enabled: true, text: "x" }, 404);
    await s.json("PUT", `/api/missed-call-text/${numberId}`, { enabled: true, text: "  " }, 400);
    const saved = await enable(s, numberId);
    expect(saved).toMatchObject({ numberId, enabled: true, text: "Sorry, missed you" });
  });

  it("texts a missed caller once per day per number, from that number", async () => {
    const { s, numberId } = await ready();
    await enable(s, numberId);
    await missedCall(s.userId, numberId, PEER);
    expect(twilioCalls).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(twilioCalls[0]!.body))).toMatchObject({
      From: OUR,
      To: PEER,
      Body: "Sorry, missed you",
    });
    await missedCall(s.userId, numberId, PEER);
    expect(twilioCalls).toHaveLength(1);
    await missedCall(s.userId, numberId, PEER2);
    expect(twilioCalls).toHaveLength(2);

    // A new day brings a new chance.
    await env.DB.prepare("UPDATE missed_call_texts SET day = '2000-01-01'").run();
    await missedCall(s.userId, numberId, PEER);
    expect(twilioCalls).toHaveLength(3);
    expect(await rows("SELECT day FROM missed_call_texts WHERE day = ?", dayKey(new Date()))).toHaveLength(1);
  });

  it("skips withheld and non-E.164 callers", async () => {
    const { s, numberId } = await ready();
    await enable(s, numberId);
    await missedCall(s.userId, numberId, "anonymous");
    await missedCall(s.userId, numberId, "72345");
    expect(twilioCalls).toHaveLength(0);
  });

  it("skips blocked numbers when a block list exists", async () => {
    const { s, numberId } = await ready();
    await enable(s, numberId);
    await env.DB.exec("CREATE TABLE blocked_numbers (owner_id TEXT NOT NULL, e164 TEXT NOT NULL)");
    try {
      await env.DB.prepare("INSERT INTO blocked_numbers (owner_id, e164) VALUES (?, ?)")
        .bind(s.userId, PEER)
        .run();
      await missedCall(s.userId, numberId, PEER);
      expect(twilioCalls).toHaveLength(0);
      await missedCall(s.userId, numberId, PEER2);
      expect(twilioCalls).toHaveLength(1);
    } finally {
      await env.DB.exec("DROP TABLE blocked_numbers");
    }
  });

  it("goes through the contact guards and lets a refused caller try again", async () => {
    const { s, numberId } = await ready();
    await enable(s, numberId);
    await allow(s.userId, '["GB"]');
    await missedCall(s.userId, numberId, PEER);
    expect(twilioCalls).toHaveLength(0);
    expect(await rows("SELECT id FROM missed_call_texts")).toHaveLength(0);

    await allow(s.userId);
    twilioStatus = 400;
    await missedCall(s.userId, numberId, PEER);
    expect(twilioCalls).toHaveLength(1);
    expect(await rows("SELECT id FROM missed_call_texts")).toHaveLength(0);

    twilioStatus = 201;
    await missedCall(s.userId, numberId, PEER);
    expect(twilioCalls).toHaveLength(2);
    expect(await rows("SELECT id FROM missed_call_texts")).toHaveLength(1);
  });
});
