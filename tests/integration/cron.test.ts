import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cronJobs,
  pruneWebhookEvents,
  runCronJobs,
  scheduled,
  WEBHOOK_EVENT_RETENTION_MS,
} from "../../src/worker/cron";
import { resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const DAY = 24 * 60 * 60 * 1000;

async function addEvent(key: string, receivedAt: number) {
  await env.DB.prepare(
    "INSERT INTO webhook_events (id, idempotency_key, type, received_at, payload_hash, attempts) VALUES (?, ?, 'test', ?, 'h', 1)",
  )
    .bind(crypto.randomUUID(), key, receivedAt)
    .run();
}

const keys = async () =>
  (
    await env.DB.prepare("SELECT idempotency_key FROM webhook_events ORDER BY idempotency_key").all()
  ).results.map((r) => r.idempotency_key);

describe("webhook_events retention", () => {
  it("deletes events older than 30 days and keeps newer ones", async () => {
    const now = Date.now();
    await addEvent("old", now - WEBHOOK_EVENT_RETENTION_MS - DAY);
    await addEvent("edge", now - WEBHOOK_EVENT_RETENTION_MS + 60_000);
    await addEvent("new", now - DAY);
    await pruneWebhookEvents(env, undefined, now);
    expect(await keys()).toEqual(["edge", "new"]);
  });

  it("is registered as a cron job", () => {
    expect(cronJobs).toContain(pruneWebhookEvents);
  });
});

describe("scheduled handler", () => {
  it("runs the jobs inside waitUntil", async () => {
    await addEvent("old", Date.now() - 40 * DAY);
    const ctx = createExecutionContext();
    scheduled(
      { cron: "*/15 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController,
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await keys()).toEqual([]);
  });

  it("keeps running the other jobs when one fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ran: string[] = [];
    const ok = async () => {
      ran.push("ok");
    };
    const broken = async () => {
      throw new Error("boom");
    };
    await runCronJobs(env, createExecutionContext(), [broken, ok]);
    expect(ran).toEqual(["ok"]);
    expect(JSON.stringify(error.mock.calls)).toContain("broken");
  });
});
