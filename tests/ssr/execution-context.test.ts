import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createOwner, resetDb } from "../integration/helpers";
import { signedTwilioPost } from "../integration/twilio-helpers";

/**
 * These go through the built Worker's default export (src/server.ts), the same path production takes. Routes
 * that hand `c.executionCtx` to notifyOwner must get the real ExecutionContext from workerd, not lose it on
 * the way into the Hono app.
 */
beforeEach(resetDb);

const OUR = "+14155550100";
const PEER = "+14155552671";
const sid = (n: number) => `SM${n.toString(16).padStart(32, "0")}`;

async function addNumber(ownerId: string) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO phone_numbers (id, owner_id, e164, twilio_sid, friendly_name, capabilities, is_default, released_at, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, 1, NULL, ?, ?)",
  )
    .bind(
      id,
      ownerId,
      OUR,
      `PN${crypto.randomUUID().replace(/-/g, "")}`,
      JSON.stringify({ voice: true, sms: true, mms: false }),
      Date.now(),
      Date.now(),
    )
    .run();
  return id;
}

const inbound = (n: number) =>
  signedTwilioPost("/api/twilio/sms/inbound", {
    MessageSid: sid(n),
    AccountSid: "AC00000000000000000000000000000000",
    From: PEER,
    To: OUR,
    Body: `hello ${n}`,
    NumMedia: "0",
  });

describe("execution context through the Worker entry", () => {
  it("accepts a signed inbound SMS webhook", async () => {
    const s = await createOwner();
    await addNumber(s.userId);
    const res = await inbound(1);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.text()).toContain("<Response/>");
    const { items } = await s.get("/api/messages/conversations");
    expect(items).toHaveLength(1);
    expect(items[0].unreadCount).toBe(1);
  });

  it("marks a thread with unread messages read", async () => {
    const s = await createOwner();
    const numberId = await addNumber(s.userId);
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO conversations (id, owner_id, number_id, participant, unread_count, created_at, updated_at) VALUES (?, ?, ?, ?, 2, ?, ?)",
    )
      .bind(id, s.userId, numberId, PEER, now, now)
      .run();
    await s.post(`/api/messages/conversations/${id}/read`);
    expect((await s.get(`/api/messages/conversations/${id}`)).unreadCount).toBe(0);
  });
});
