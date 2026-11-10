import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cronJobs } from "../../src/worker/cron";
import { QUEUE_SWEEP_AGE_MS, sweepLeftoverQueues } from "../../src/worker/lib/voice/queues";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const NOW = Date.parse("2026-11-09T12:00:00Z");
const sid = (n: number) => `QU${String(n).padStart(32, "0")}`;
const created = (ageMs: number) => new Date(NOW - ageMs).toUTCString();
const OLD = QUEUE_SWEEP_AGE_MS + 60_000;

function mockTwilio(pages: object[]) {
  const deleted: string[] = [];
  const listed: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input instanceof Request ? input.url : input));
      if (init?.method === "DELETE") {
        deleted.push(u.pathname.split("/").pop()!);
        return new Response(null, { status: 204 });
      }
      listed.push(u.search);
      return Response.json(pages[Number(u.searchParams.get("Page") ?? 0)] ?? { queues: [] });
    }),
  );
  return { deleted, listed };
}

describe("cron: leftover queue sweep", () => {
  it("is registered as a cron job", () => {
    expect(cronJobs).toContain(sweepLeftoverQueues);
  });

  it("deletes only empty, old queues made by this app, across pages", async () => {
    const { deleted, listed } = mockTwilio([
      {
        queues: [
          { sid: sid(1), friendly_name: "tq_a", current_size: 0, date_created: created(OLD) },
          { sid: sid(2), friendly_name: "tq_b", current_size: 1, date_created: created(OLD) },
          { sid: sid(3), friendly_name: "tq_c", current_size: 0, date_created: created(60_000) },
          { sid: sid(4), friendly_name: "support", current_size: 0, date_created: created(OLD) },
        ],
        next_page_uri: "/2010-04-01/Accounts/AC0/Queues.json?PageSize=100&Page=1&PageToken=abc",
      },
      { queues: [{ sid: sid(5), friendly_name: "tq_d", current_size: 0, date_created: created(OLD) }] },
    ]);
    await sweepLeftoverQueues(env, undefined, NOW);
    expect(deleted).toEqual([`${sid(1)}.json`, `${sid(5)}.json`]);
    expect(listed).toHaveLength(2);
    expect(listed[1]).toContain("PageToken=abc");
  });

  it("sweeps hold queues (th_) the same way", async () => {
    const { deleted } = mockTwilio([
      {
        queues: [
          { sid: sid(6), friendly_name: "th_a", current_size: 0, date_created: created(OLD) },
          { sid: sid(7), friendly_name: "th_b", current_size: 1, date_created: created(OLD) },
          { sid: sid(8), friendly_name: "th_c", current_size: 0, date_created: created(60_000) },
          { sid: sid(9), friendly_name: "thx", current_size: 0, date_created: created(OLD) },
        ],
      },
    ]);
    await sweepLeftoverQueues(env, undefined, NOW);
    expect(deleted).toEqual([`${sid(6)}.json`]);
  });

  it("skips quietly when Twilio is not configured", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await sweepLeftoverQueues({ ...env, TWILIO_API_KEY_SECRET: "" } as Env, undefined, NOW);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never throws when Twilio fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ code: 500, message: "boom" }, { status: 500 })),
    );
    await expect(sweepLeftoverQueues(env, undefined, NOW)).resolves.toBeUndefined();
  });
});
