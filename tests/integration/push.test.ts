import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "../../src/contracts";
import { notifyOwner } from "../../src/worker/lib/hub";
import { fitPayload, MAX_PAYLOAD_BYTES, sendPushToOwner } from "../../src/worker/lib/push";
import {
  b64u,
  decryptWebPush,
  newReceiver,
  newVapid,
  type Receiver,
  text,
  verifyVapid,
} from "../unit/webpush-decrypt";
import { createOwner, resetDb, Session } from "./helpers";

declare global {
  namespace Cloudflare {
    interface Env {
      VAPID_PUBLIC_KEY?: string;
      VAPID_PRIVATE_KEY?: string;
      VAPID_SUBJECT?: string;
    }
  }
}

type Vapid = Awaited<ReturnType<typeof newVapid>>;
let vapid: Vapid;

beforeEach(async () => {
  await resetDb();
  vapid = await newVapid();
  env.VAPID_PUBLIC_KEY = vapid.publicKey;
  env.VAPID_PRIVATE_KEY = vapid.privateKey;
  env.VAPID_SUBJECT = vapid.subject;
});

afterEach(() => {
  vi.restoreAllMocks();
  env.VAPID_PUBLIC_KEY = undefined;
  env.VAPID_PRIVATE_KEY = undefined;
  env.VAPID_SUBJECT = undefined;
});

const subscriptionBody = (endpoint: string, r: Receiver) => ({
  endpoint,
  keys: { p256dh: b64u.encode(r.publicKey), auth: b64u.encode(r.authSecret) },
});

async function seed(ownerId: string, endpoint: string, r: Receiver) {
  await env.DB.prepare(
    "INSERT INTO push_subscriptions (id, owner_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      ownerId,
      endpoint,
      b64u.encode(r.publicKey),
      b64u.encode(r.authSecret),
      Date.now(),
    )
    .run();
}

const endpoints = async () =>
  (
    await env.DB.prepare("SELECT endpoint FROM push_subscriptions ORDER BY endpoint").all<{
      endpoint: string;
    }>()
  ).results.map((r) => r.endpoint);

/** Replaces fetch with one that answers per endpoint and records what the Worker sent. */
function pushService(status: (url: string) => number = () => 201) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    calls.push({ url, init: init ?? {} });
    return new Response(null, { status: status(url) });
  });
  return calls;
}

describe("/api/push", () => {
  it("needs the owner's session", async () => {
    const s = new Session();
    expect((await s.fetch("/api/push/vapid-public-key")).status).toBe(401);
    expect((await s.fetch("/api/push/subscriptions", { method: "POST", json: {} })).status).toBe(401);
    expect((await s.fetch("/api/push/test", { method: "POST", json: {} })).status).toBe(401);
  });

  it("refuses cross-site writes", async () => {
    const s = await createOwner();
    const res = await s.fetch("/api/push/test", { method: "POST", json: {}, origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("returns the public key, or null when push is not configured", async () => {
    const s = await createOwner();
    expect(await s.get("/api/push/vapid-public-key")).toEqual({ publicKey: vapid.publicKey });
    env.VAPID_PRIVATE_KEY = undefined;
    expect(await s.get("/api/push/vapid-public-key")).toEqual({ publicKey: null });
  });

  it("stores a subscription once per endpoint and replaces its keys on resubscribe", async () => {
    const s = await createOwner();
    const first = await newReceiver();
    const second = await newReceiver();
    const endpoint = "https://push.example.test/send/one";
    await s.post("/api/push/subscriptions", subscriptionBody(endpoint, first), 201);
    await s.post("/api/push/subscriptions", subscriptionBody(endpoint, second), 201);
    const rows = await env.DB.prepare("SELECT owner_id, p256dh, auth FROM push_subscriptions").all();
    expect(rows.results).toEqual([
      { owner_id: s.userId, p256dh: b64u.encode(second.publicKey), auth: b64u.encode(second.authSecret) },
    ]);
  });

  it("rejects an endpoint that is not https and keys that are not base64url", async () => {
    const s = await createOwner();
    const r = await newReceiver();
    await s.post("/api/push/subscriptions", subscriptionBody("http://push.example.test/x", r), 400);
    await s.post(
      "/api/push/subscriptions",
      { endpoint: "https://push.example.test/x", keys: { p256dh: "a b", auth: "x" } },
      400,
    );
    expect(await endpoints()).toEqual([]);
  });

  it("deletes a subscription by endpoint and leaves the others", async () => {
    const s = await createOwner();
    const r = await newReceiver();
    await s.post("/api/push/subscriptions", subscriptionBody("https://push.example.test/a", r), 201);
    await s.post("/api/push/subscriptions", subscriptionBody("https://push.example.test/b", r), 201);
    await s.json("DELETE", "/api/push/subscriptions", { endpoint: "https://push.example.test/a" });
    expect(await endpoints()).toEqual(["https://push.example.test/b"]);
  });

  it("answers 503 on /test when push keys are not set", async () => {
    const s = await createOwner();
    env.VAPID_SUBJECT = undefined;
    await s.post("/api/push/test", {}, 503);
  });

  it("sends the test notice to this owner's devices only", async () => {
    const s = await createOwner();
    const mine = await newReceiver();
    const theirs = await newReceiver();
    await env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('other', 'Other', 'other@talvuno.test', 0, 1, 1)",
    ).run();
    await seed(s.userId, "https://push.example.test/mine", mine);
    await seed("other", "https://push.example.test/theirs", theirs);
    const calls = pushService();

    expect(await s.post("/api/push/test")).toEqual({ sent: 1, removed: 0, failed: 0 });
    expect(calls.map((c) => c.url)).toEqual(["https://push.example.test/mine"]);
    const body = new Uint8Array(calls[0]!.init.body as ArrayBuffer | Uint8Array);
    expect(JSON.parse(text(await decryptWebPush(body, mine)))).toMatchObject({
      title: "Talvuno",
      url: "/settings",
    });
  });
});

describe("sendPushToOwner", () => {
  it("encrypts for each device, signs with VAPID and records the send", async () => {
    const s = await createOwner();
    const phone = await newReceiver();
    const laptop = await newReceiver();
    await seed(s.userId, "https://push.example.test/phone", phone);
    await seed(s.userId, "https://push.example.test/laptop", laptop);
    const calls = pushService();

    const result = await sendPushToOwner(env, s.userId, {
      title: "New message",
      body: "Hi",
      url: "/messages",
      tag: "m1",
    });
    expect(result).toEqual({ sent: 2, removed: 0, failed: 0 });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      const { claims } = await verifyVapid(headers.authorization!, vapid.publicKey);
      expect(claims.aud).toBe("https://push.example.test");
      const receiver = call.url.endsWith("phone") ? phone : laptop;
      const plain = await decryptWebPush(
        new Uint8Array(call.init.body as ArrayBuffer | Uint8Array),
        receiver,
      );
      expect(JSON.parse(text(plain))).toEqual({
        title: "New message",
        body: "Hi",
        url: "/messages",
        tag: "m1",
      });
    }
    const used = await env.DB.prepare(
      "SELECT count(*) AS n FROM push_subscriptions WHERE last_used_at IS NOT NULL",
    ).first<{ n: number }>();
    expect(used?.n).toBe(2);
  });

  it("deletes subscriptions that answer 404 or 410 and keeps the rest", async () => {
    const s = await createOwner();
    const r = await newReceiver();
    for (const name of ["ok", "gone", "missing", "busy"])
      await seed(s.userId, `https://push.example.test/${name}`, r);
    pushService((url) =>
      url.endsWith("gone") ? 410 : url.endsWith("missing") ? 404 : url.endsWith("busy") ? 503 : 201,
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendPushToOwner(env, s.userId, { title: "t", body: "b", url: "/" });
    expect(result).toEqual({ sent: 1, removed: 2, failed: 1 });
    expect(await endpoints()).toEqual(["https://push.example.test/busy", "https://push.example.test/ok"]);
  });

  it("never throws: a network error, or missing keys, is a quiet result", async () => {
    const s = await createOwner();
    await seed(s.userId, "https://push.example.test/a", await newReceiver());
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    expect(await sendPushToOwner(env, s.userId, { title: "t", body: "b", url: "/" })).toEqual({
      sent: 0,
      removed: 0,
      failed: 1,
    });
    expect(await endpoints()).toEqual(["https://push.example.test/a"]);

    env.VAPID_PRIVATE_KEY = undefined;
    expect(await sendPushToOwner(env, s.userId, { title: "t", body: "b", url: "/" })).toEqual({
      sent: 0,
      removed: 0,
      failed: 0,
    });
  });
});

describe("fitPayload", () => {
  const size = (p: object) => new TextEncoder().encode(JSON.stringify(p)).length;

  it("leaves a small payload alone", () => {
    const p = { title: "Ann", body: "hi", url: "/messages" };
    expect(fitPayload(p)).toEqual(p);
  });

  it("shortens a long non-ASCII body under the byte limit and keeps the title", () => {
    const p = { title: "Ann", body: "\u00e9\u4e2d\ud83d\ude00".repeat(2000), url: "/messages", tag: "c1" };
    const out = fitPayload(p);
    expect(size(out)).toBeLessThan(MAX_PAYLOAD_BYTES);
    expect(out.title).toBe("Ann");
    expect(out.body.endsWith("\u2026")).toBe(true);
    expect(out.body).not.toContain("\ufffd");
  });

  it("shortens an oversized title when the body alone is not enough", () => {
    const out = fitPayload({ title: "\u4e2d".repeat(5000), body: "b", url: "/" });
    expect(size(out)).toBeLessThan(MAX_PAYLOAD_BYTES);
  });
});

describe("notifyOwner and web push", () => {
  const withPush: LiveEvent = {
    type: "message",
    conversationId: "c1",
    messageId: "m1",
    push: { title: "Ann", body: "Are you there?", url: "/messages", tag: "c1" },
  };

  it("sends a web push when the event carries push and no tab is open", async () => {
    const s = await createOwner();
    await seed(s.userId, "https://push.example.test/a", await newReceiver());
    const calls = pushService();
    expect(await notifyOwner(env, s.userId, withPush)).toBe(0);
    expect(calls.map((c) => c.url)).toEqual(["https://push.example.test/a"]);
  });

  it("hands the push to waitUntil when the caller has a context", async () => {
    const s = await createOwner();
    await seed(s.userId, "https://push.example.test/a", await newReceiver());
    const calls = pushService();
    const pending: Promise<unknown>[] = [];
    await notifyOwner(env, s.userId, withPush, { waitUntil: (p) => void pending.push(p) });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(calls).toHaveLength(1);
  });

  it("does not push when a tab was open to receive the event", async () => {
    const s = await createOwner();
    await seed(s.userId, "https://push.example.test/a", await newReceiver());
    const res = await s.fetch("/api/live", { headers: { upgrade: "websocket" } });
    const ws = res.webSocket!;
    ws.accept();
    const calls = pushService();
    expect(await notifyOwner(env, s.userId, withPush)).toBe(1);
    expect(calls).toEqual([]);
    ws.close();
  });

  it("does not push for an event without a push field", async () => {
    const s = await createOwner();
    await seed(s.userId, "https://push.example.test/a", await newReceiver());
    const calls = pushService();
    expect(await notifyOwner(env, s.userId, { type: "conversation", conversationId: "c1" })).toBe(0);
    expect(calls).toEqual([]);
  });

  it("still returns when the push service fails", async () => {
    const s = await createOwner();
    await seed(s.userId, "https://push.example.test/a", await newReceiver());
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    await expect(notifyOwner(env, s.userId, withPush)).resolves.toBe(0);
  });

  it("truncates an oversized notice instead of dropping it, and never throws", async () => {
    const s = await createOwner();
    await seed(s.userId, "https://push.example.test/a", await newReceiver());
    const calls = pushService();
    const long: LiveEvent = {
      type: "message",
      conversationId: "c1",
      messageId: "m1",
      push: { title: "T".repeat(500), body: "x".repeat(5000), url: "/messages" },
    };
    await expect(notifyOwner(env, s.userId, long)).resolves.toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("does not throw on an event that fails validation", async () => {
    const s = await createOwner();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = { ...withPush, push: { title: "a", body: "b", url: "https://evil.example" } } as LiveEvent;
    await expect(notifyOwner(env, s.userId, bad)).resolves.toBe(0);
  });
});
