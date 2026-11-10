import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cronJobs, scheduled } from "../../src/worker/cron";
import { createDb } from "../../src/worker/db";
import { claimDue, sendDueScheduled } from "../../src/worker/lib/scheduled";
import { createOwner, resetDb, Session } from "./helpers";

const OUR = "+14155550100";
const PEER = "+14155552671";
const MIN = 60 * 1000;

let twilioCalls: string[] = [];

beforeEach(async () => {
  await resetDb();
  twilioCalls = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith("https://twilio.mock/")) return real(input, init);
    // Other cron jobs may call Twilio too: only text sends count here.
    if (!url.endsWith("/Messages.json")) return Response.json({}, { status: 200 });
    twilioCalls.push(typeof init?.body === "string" ? init.body : "");
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

/** Makes a scheduled row due by moving its time into the past (the API refuses past times). */
const makeDue = (id: string) =>
  env.DB.prepare("UPDATE scheduled_messages SET send_at = ? WHERE id = ?")
    .bind(Date.now() - MIN, id)
    .run();

const create = (s: Session, numberId: string, extra: Record<string, unknown> = {}) =>
  s.post(
    "/api/scheduled-messages",
    {
      numberId,
      to: PEER,
      body: "See you at nine",
      sendAt: Date.now() + 10 * MIN,
      ...extra,
    },
    201,
  );

describe("scheduled texts API", () => {
  it("requires a session", async () => {
    expect((await new Session().fetch("/api/scheduled-messages")).status).toBe(401);
  });

  it("creates, lists and normalises the number", async () => {
    const { s, numberId } = await ready();
    const made = await s.post(
      "/api/scheduled-messages",
      { numberId, to: "+1 415 555 2671", body: "Hi", sendAt: Date.now() + 5 * MIN },
      201,
    );
    expect(made).toMatchObject({ status: "scheduled", to: PEER, numberE164: OUR, messageId: null });
    const list = await s.get("/api/scheduled-messages");
    expect(list.map((r: { id: string }) => r.id)).toEqual([made.id]);
    const thread = await s.get(`/api/scheduled-messages?numberId=${numberId}&to=${encodeURIComponent(PEER)}`);
    expect(thread).toHaveLength(1);
    expect(await s.get(`/api/scheduled-messages?to=${encodeURIComponent("+14155552999")}`)).toHaveLength(0);
  });

  it("enforces the 2 minute minimum and the 1 year maximum", async () => {
    const { s, numberId } = await ready();
    const soon = await s.json(
      "POST",
      "/api/scheduled-messages",
      { numberId, to: PEER, body: "x", sendAt: Date.now() + MIN },
      400,
    );
    expect(soon.error).toBe("send_at_too_soon");
    const far = await s.json(
      "POST",
      "/api/scheduled-messages",
      { numberId, to: PEER, body: "x", sendAt: Date.now() + 366 * 24 * 60 * MIN },
      400,
    );
    expect(far.error).toBe("send_at_too_far");
    await s.json(
      "POST",
      "/api/scheduled-messages",
      { numberId, to: PEER, body: "x", sendAt: Date.now() + 3 * MIN },
      201,
    );
    await s.json(
      "POST",
      "/api/scheduled-messages",
      { numberId, to: PEER, body: "x", sendAt: Date.now() + 364 * 24 * 60 * MIN },
      201,
    );
  });

  it("validates the body, the number and the recipient", async () => {
    const { s, numberId } = await ready();
    const at = Date.now() + 10 * MIN;
    await s.json("POST", "/api/scheduled-messages", { numberId, to: PEER, body: "", sendAt: at }, 400);
    await s.json(
      "POST",
      "/api/scheduled-messages",
      { numberId, to: PEER, body: "x".repeat(1601), sendAt: at },
      400,
    );
    await s.json(
      "POST",
      "/api/scheduled-messages",
      { numberId, to: PEER, body: "x".repeat(1600), sendAt: at },
      201,
    );
    await s.json(
      "POST",
      "/api/scheduled-messages",
      { numberId, to: "not a number", body: "x", sendAt: at },
      400,
    );
    await s.json(
      "POST",
      "/api/scheduled-messages",
      { numberId: "nope", to: PEER, body: "x", sendAt: at },
      404,
    );
    await s.json(
      "POST",
      "/api/scheduled-messages",
      { numberId, to: PEER, body: "x", sendAt: at, ownerId: "other" },
      400,
    );
  });

  it("keeps rows owner scoped", async () => {
    const { s, numberId } = await ready();
    const made = await create(s, numberId);
    // A second owner cannot exist through setup, so seed one directly.
    await env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('other', 'O', 'o@talvuno.test', 1, 0, 0)",
    ).run();
    const otherNumber = await addNumber("other", "+14155550199");
    await env.DB.prepare(
      "INSERT INTO scheduled_messages (id, owner_id, number_id, `to`, body, send_at, status, created_at, updated_at) VALUES ('theirs', 'other', ?, ?, 'secret', ?, 'scheduled', 0, 0)",
    )
      .bind(otherNumber, PEER, Date.now() + 10 * MIN)
      .run();
    const list = await s.get("/api/scheduled-messages");
    expect(list.map((r: { id: string }) => r.id)).toEqual([made.id]);
    await s.json("PATCH", "/api/scheduled-messages/theirs", { body: "mine now" }, 404);
    await s.json("DELETE", "/api/scheduled-messages/theirs", undefined, 404);
    expect((await rows("SELECT body, status FROM scheduled_messages WHERE id = 'theirs'"))[0]).toEqual({
      body: "secret",
      status: "scheduled",
    });
    // Sending as someone else's number is refused.
    await s.json(
      "POST",
      "/api/scheduled-messages",
      { numberId: otherNumber, to: PEER, body: "x", sendAt: Date.now() + 10 * MIN },
      404,
    );
  });

  it("edits the body and time while scheduled, and refuses once it is no longer waiting", async () => {
    const { s, numberId } = await ready();
    const made = await create(s, numberId);
    const at = Date.now() + 30 * MIN;
    const edited = await s.json(
      "PATCH",
      `/api/scheduled-messages/${made.id}`,
      { body: "Running late", sendAt: at },
      200,
    );
    expect(edited).toMatchObject({ body: "Running late", sendAt: at, status: "scheduled" });
    await s.json("PATCH", `/api/scheduled-messages/${made.id}`, { sendAt: Date.now() + MIN }, 400);
    await s.json("PATCH", `/api/scheduled-messages/${made.id}`, {}, 400);
    await env.DB.prepare("UPDATE scheduled_messages SET status = 'sending' WHERE id = ?").bind(made.id).run();
    const late = await s.json("PATCH", `/api/scheduled-messages/${made.id}`, { body: "Too late" }, 409);
    expect(late.error).toBe("not_scheduled");
  });

  it("cancels before send, and a cancelled text never goes out", async () => {
    const { s, numberId } = await ready();
    const made = await create(s, numberId);
    const gone = await s.json("DELETE", `/api/scheduled-messages/${made.id}`, undefined, 200);
    expect(gone.status).toBe("cancelled");
    expect(await s.get("/api/scheduled-messages")).toHaveLength(0);
    await makeDue(made.id);
    await sendDueScheduled(env);
    expect(twilioCalls).toHaveLength(0);
    expect(await rows("SELECT id FROM messages")).toHaveLength(0);
    await s.json("DELETE", `/api/scheduled-messages/${made.id}`, undefined, 409);
  });
});

describe("sending scheduled texts", () => {
  it("is registered as a cron job", () => {
    expect(cronJobs).toContain(sendDueScheduled);
  });

  it("sends due texts through deliverSms, stores the message and marks the row sent", async () => {
    const { s, numberId } = await ready();
    const due = await create(s, numberId);
    const later = await create(s, numberId, { body: "Later" });
    await makeDue(due.id);

    const ctx = createExecutionContext();
    scheduled(
      { cron: "*/15 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController,
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(twilioCalls).toHaveLength(1);
    const [row] = await rows("SELECT status, message_id, error FROM scheduled_messages WHERE id = ?", due.id);
    expect(row?.status).toBe("sent");
    const [msg] = await rows("SELECT id, body, direction, client_id FROM messages");
    expect(msg).toMatchObject({
      body: "See you at nine",
      direction: "outbound",
      client_id: `sched-${due.id}`,
    });
    expect(row?.message_id).toBe(msg?.id);
    const [other] = await rows("SELECT status FROM scheduled_messages WHERE id = ?", later.id);
    expect(other?.status).toBe("scheduled");
  });

  it("never double sends when two runs overlap", async () => {
    const { s, numberId } = await ready();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await create(s, numberId, { body: `Text ${i}` })).id);
    for (const id of ids) await makeDue(id);

    await Promise.all([sendDueScheduled(env), sendDueScheduled(env)]);

    expect(twilioCalls).toHaveLength(3);
    expect(await rows("SELECT id FROM messages")).toHaveLength(3);
    expect((await rows("SELECT status FROM scheduled_messages")).every((r) => r.status === "sent")).toBe(
      true,
    );
  });

  it("lets only one claim win a row", async () => {
    const { s, numberId } = await ready();
    const made = await create(s, numberId);
    await makeDue(made.id);
    const db = createDb(env.DB);
    const [a, b] = await Promise.all([claimDue(db, Date.now()), claimDue(db, Date.now())]);
    expect(a.length + b.length).toBe(1);
  });

  it("retries a row stuck in sending without sending twice", async () => {
    const { s, numberId } = await ready();
    const made = await create(s, numberId);
    await env.DB.prepare(
      "UPDATE scheduled_messages SET status = 'sending', send_at = ?, updated_at = ? WHERE id = ?",
    )
      .bind(Date.now() - 2 * MIN, Date.now() - 40 * MIN, made.id)
      .run();
    // A fresh claim by a live run is left alone.
    await env.DB.prepare("UPDATE scheduled_messages SET updated_at = ? WHERE id = ?")
      .bind(Date.now(), made.id)
      .run();
    await sendDueScheduled(env);
    expect(twilioCalls).toHaveLength(0);
    await env.DB.prepare("UPDATE scheduled_messages SET updated_at = ? WHERE id = ?")
      .bind(Date.now() - 40 * MIN, made.id)
      .run();
    await sendDueScheduled(env);
    await sendDueScheduled(env);
    expect(twilioCalls).toHaveLength(1);
    expect((await rows("SELECT status FROM scheduled_messages"))[0]?.status).toBe("sent");
  });

  it("adopts the message a dead run already sent instead of sending again", async () => {
    const { s, numberId } = await ready();
    const made = await create(s, numberId);
    const convId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO conversations (id, owner_id, number_id, participant, unread_count, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
    )
      .bind(convId, s.userId, numberId, PEER, now, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO messages (id, owner_id, conversation_id, direction, `from`, `to`, body, status, client_id, created_at, updated_at) VALUES (?, ?, ?, 'outbound', ?, ?, 'Hi', 'sent', ?, ?, ?)",
    )
      .bind(messageId, s.userId, convId, OUR, PEER, `sched-${made.id}`, now, now)
      .run();
    await env.DB.prepare(
      "UPDATE scheduled_messages SET status = 'sending', send_at = ?, updated_at = ? WHERE id = ?",
    )
      .bind(now - 2 * MIN, now - 40 * MIN, made.id)
      .run();
    await sendDueScheduled(env);
    expect(twilioCalls).toHaveLength(0);
    const [row] = await rows("SELECT status, message_id FROM scheduled_messages");
    expect(row?.status).toBe("sent");
    expect(row?.message_id).toBe(messageId);
    expect(await rows("SELECT id FROM messages")).toHaveLength(1);
  });

  it("marks the row failed with the guard's reason when a guard refuses", async () => {
    const { s, numberId } = await ready();
    const made = await create(s, numberId);
    await makeDue(made.id);
    await allow(s.userId, '["AU"]');
    await sendDueScheduled(env);
    expect(twilioCalls).toHaveLength(0);
    const [row] = await rows("SELECT status, error, message_id FROM scheduled_messages");
    expect(row?.status).toBe("failed");
    expect(String(row?.error)).toContain("allowed list");
    expect(row?.message_id).toBeNull();
    expect(await rows("SELECT id FROM messages")).toHaveLength(0);
    // The reason reaches the screen, and a failed row can be dismissed.
    const [shown] = await s.get("/api/scheduled-messages");
    expect(shown).toMatchObject({ status: "failed" });
    await s.json("DELETE", `/api/scheduled-messages/${made.id}`, undefined, 200);
  });

  it("applies the hourly text limit to scheduled texts", async () => {
    const { s, numberId } = await ready();
    await allow(s.userId, '["US"]', 1);
    const first = await create(s, numberId, { body: "One" });
    const second = await create(s, numberId, { body: "Two" });
    await makeDue(first.id);
    await makeDue(second.id);
    await sendDueScheduled(env);
    const statuses = (await rows("SELECT status FROM scheduled_messages")).map((r) => r.status).sort();
    expect(statuses).toEqual(["failed", "sent"]);
    expect(twilioCalls).toHaveLength(1);
  });

  it("fails a text whose number was released", async () => {
    const { s, numberId } = await ready();
    const made = await create(s, numberId);
    await makeDue(made.id);
    await env.DB.prepare("UPDATE phone_numbers SET released_at = ? WHERE id = ?")
      .bind(Date.now(), numberId)
      .run();
    await sendDueScheduled(env);
    expect(twilioCalls).toHaveLength(0);
    expect((await rows("SELECT status FROM scheduled_messages"))[0]?.status).toBe("failed");
  });
});
