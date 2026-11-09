import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createOwner, resetDb } from "./helpers";

beforeEach(resetDb);

const run = (sql: string, ...params: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...params)
    .run();

async function seedNumber(ownerId: string, id: string, e164: string, sid: string, isDefault: 0 | 1) {
  await run(
    `INSERT INTO phone_numbers (id, owner_id, e164, twilio_sid, capabilities, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, '{"voice":true,"sms":true,"mms":false}', ?, 0, 0)`,
    id,
    ownerId,
    e164,
    sid,
    isDefault,
  );
}

describe("migration 0000", () => {
  it("creates every table", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name).sort()).toEqual(
      [
        "account",
        "audit_events",
        "calls",
        "contact_numbers",
        "contacts",
        "conversations",
        "messages",
        "owner_claim",
        "phone_numbers",
        "push_subscriptions",
        "rate_limit",
        "session",
        "spend_events",
        "user",
        "user_preferences",
        "verification",
        "webhook_events",
      ].sort(),
    );
  });

  it("allows one default number per owner", async () => {
    const { userId } = await createOwner();
    await seedNumber(userId, "n1", "+14155550100", "PN1", 1);
    await seedNumber(userId, "n2", "+14155550101", "PN2", 0);
    await expect(seedNumber(userId, "n3", "+14155550102", "PN3", 1)).rejects.toThrow(/UNIQUE/);
  });

  it("keeps one conversation per (number, participant) and unique message and call SIDs", async () => {
    const { userId } = await createOwner();
    await seedNumber(userId, "n1", "+14155550100", "PN1", 1);
    const conv = `INSERT INTO conversations (id, owner_id, number_id, participant, unread_count, created_at, updated_at)
      VALUES (?, ?, 'n1', '+14155550199', 0, 0, 0)`;
    await run(conv, "c1", userId);
    await expect(run(conv, "c2", userId)).rejects.toThrow(/UNIQUE/);

    const msg = `INSERT INTO messages (id, owner_id, conversation_id, twilio_sid, direction, "from", "to", body, status, created_at, updated_at)
      VALUES (?, ?, 'c1', ?, 'inbound', '+14155550199', '+14155550100', 'hi', 'received', 0, 0)`;
    await run(msg, "m1", userId, "SM1");
    await expect(run(msg, "m2", userId, "SM1")).rejects.toThrow(/UNIQUE/);
    // Outbound rows waiting for Twilio's SID may share a NULL SID.
    await run(msg, "m3", userId, null);
    await run(msg, "m4", userId, null);

    const call = `INSERT INTO calls (id, owner_id, twilio_call_sid, direction, party, status, created_at, updated_at)
      VALUES (?, ?, 'CA1', 'inbound', '+14155550199', 'ringing', 0, 0)`;
    await run(call, "k1", userId);
    await expect(run(call, "k2", userId)).rejects.toThrow(/UNIQUE/);
  });

  it("deduplicates webhook events by idempotency key", async () => {
    const ins = `INSERT INTO webhook_events (id, idempotency_key, type, received_at, payload_hash) VALUES (?, 'sms:SM1', 'sms', 0, 'h')`;
    await run(ins, "w1");
    await expect(run(ins, "w2")).rejects.toThrow(/UNIQUE/);
  });

  it("refuses to delete a number, or a conversation, that still has history", async () => {
    const { userId } = await createOwner();
    await seedNumber(userId, "n1", "+14155550100", "PN1", 1);
    await run(
      `INSERT INTO conversations (id, owner_id, number_id, participant, unread_count, created_at, updated_at)
       VALUES ('c1', ?, 'n1', '+14155550199', 0, 0, 0)`,
      userId,
    );
    await run(
      `INSERT INTO messages (id, owner_id, conversation_id, direction, "from", "to", body, status, created_at, updated_at)
       VALUES ('m1', ?, 'c1', 'inbound', '+14155550199', '+14155550100', 'hi', 'received', 0, 0)`,
      userId,
    );
    await run(
      `INSERT INTO phone_numbers (id, owner_id, e164, twilio_sid, capabilities, is_default, created_at, updated_at)
       VALUES ('n2', ?, '+14155550101', 'PN2', '{"voice":true,"sms":true,"mms":false}', 0, 0, 0)`,
      userId,
    );
    await run(
      `INSERT INTO calls (id, owner_id, twilio_call_sid, direction, number_id, party, status, created_at, updated_at)
       VALUES ('k1', ?, 'CA1', 'inbound', 'n2', '+14155550199', 'completed', 0, 0)`,
      userId,
    );
    await expect(run("DELETE FROM phone_numbers WHERE id = 'n1'")).rejects.toThrow(/FOREIGN KEY/);
    await expect(run("DELETE FROM phone_numbers WHERE id = 'n2'")).rejects.toThrow(/FOREIGN KEY/);
    await expect(run("DELETE FROM conversations WHERE id = 'c1'")).rejects.toThrow(/FOREIGN KEY/);
    // A release is a soft delete: the row stays and the history keeps its number.
    await run("UPDATE phone_numbers SET released_at = 1 WHERE id = 'n1'");
    const kept = await env.DB.prepare("SELECT count(*) AS n FROM messages").first<{ n: number }>();
    expect(kept?.n).toBe(1);
  });

  it("deleting the owner removes their data", async () => {
    const { userId } = await createOwner();
    await seedNumber(userId, "n1", "+14155550100", "PN1", 1);
    await run("DELETE FROM user WHERE id = ?", userId);
    const n = await env.DB.prepare("SELECT count(*) AS n FROM phone_numbers").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
