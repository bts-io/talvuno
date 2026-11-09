import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { consume, hubFor, notifyOwner } from "../../src/worker/lib/hub";
import { createOwner, resetDb, Session } from "./helpers";

beforeEach(resetDb);

/** Opens /api/live as `s` and returns the socket plus a queue of received frames. */
async function openLive(s: Session) {
  const res = await s.fetch("/api/live", { headers: { upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const frames: string[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener("message", (e) => {
    frames.push(String(e.data));
    waiters.shift()?.();
  });
  ws.accept();
  const next = async () => {
    if (!frames.length) await new Promise<void>((r) => waiters.push(r));
    return JSON.parse(frames.shift()!);
  };
  return { ws, next };
}

describe("GET /api/live", () => {
  it("needs a session", async () => {
    const res = await new Session().fetch("/api/live", { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(401);
  });

  it("refuses a cross-site upgrade", async () => {
    const s = await createOwner();
    const res = await s.fetch("/api/live", {
      headers: { upgrade: "websocket" },
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
  });

  it("answers 426 without an upgrade header", async () => {
    const s = await createOwner();
    expect((await s.fetch("/api/live")).status).toBe(426);
  });

  it("delivers notify() events to every open socket of the owner", async () => {
    const s = await createOwner();
    const a = await openLive(s);
    const b = await openLive(s);
    expect(await a.next()).toMatchObject({ type: "hello" });
    expect(await b.next()).toMatchObject({ type: "hello" });

    const delivered = await notifyOwner(env, s.userId, {
      type: "message",
      conversationId: "c1",
      messageId: "m1",
    });
    expect(delivered).toBe(2);
    expect(await a.next()).toEqual({ type: "message", conversationId: "c1", messageId: "m1" });
    expect(await b.next()).toEqual({ type: "message", conversationId: "c1", messageId: "m1" });
    a.ws.close();
    b.ws.close();
  });

  it("answers ping with pong through the runtime auto-response", async () => {
    const s = await createOwner();
    const { ws, next } = await openLive(s);
    await next(); // hello
    const pong = new Promise<string>((resolve) =>
      ws.addEventListener("message", (e) => resolve(String(e.data))),
    );
    ws.send("ping");
    expect(await pong).toBe("pong");
    // The pair is registered on the hub, which is what keeps idle sockets from waking it.
    await runInDurableObject(hubFor(env, s.userId), async (_i, state) => {
      expect(state.getWebSocketAutoResponse()?.request).toBe("ping");
    });
    ws.close();
  });

  it("keeps owners apart: another hub's sockets get nothing", async () => {
    const s = await createOwner();
    const a = await openLive(s);
    await a.next();
    expect(await notifyOwner(env, "someone-else", { type: "conversation", conversationId: "x" })).toBe(0);
    a.ws.close();
  });

  it("drops malformed events without throwing, so notifyOwner never fails a webhook", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(notifyOwner(env, "o", { type: "nope" } as never)).resolves.toBe(0);
  });
});

describe("OwnerHub.consume", () => {
  it("allows exactly `limit` units per window, even under concurrency", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => consume(env, "owner-a", "sms", 5)));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.filter((r) => !r.allowed).every((r) => r.remaining === 0)).toBe(true);
    expect(results.map((r) => r.remaining).sort()).toContain(0);
  });

  it("counts SMS and calls separately", async () => {
    expect((await consume(env, "owner-b", "sms", 1)).allowed).toBe(true);
    expect((await consume(env, "owner-b", "sms", 1)).allowed).toBe(false);
    expect((await consume(env, "owner-b", "call", 1)).allowed).toBe(true);
  });

  it("frees units once they leave the window", async () => {
    const stub = hubFor(env, "owner-c");
    expect((await stub.consume("call", 1, 3600)).allowed).toBe(true);
    expect((await stub.consume("call", 1, 3600)).allowed).toBe(false);
    // Age the stored hit past the window instead of sleeping.
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("consume:call", [Date.now() - 3601 * 1000]);
    });
    const after = await stub.consume("call", 1, 3600);
    expect(after).toMatchObject({ allowed: true, remaining: 0 });
  });

  it("refuses a limit or window that is not a usable integer", async () => {
    const stub = hubFor(env, "owner-e");
    const refused = { allowed: false, remaining: 0 };
    for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(await stub.consume("sms", limit, 3600)).toMatchObject(refused);
    for (const window of [0, -5, 0.5, Number.NaN])
      expect(await stub.consume("sms", 5, window)).toMatchObject(refused);
    // Nothing was recorded by the refused calls.
    expect(await stub.consume("sms", 1, 3600)).toMatchObject({ allowed: true });
  });

  it("allows nothing with a zero limit", async () => {
    expect((await consume(env, "owner-d", "sms", 0)).allowed).toBe(false);
  });
});
