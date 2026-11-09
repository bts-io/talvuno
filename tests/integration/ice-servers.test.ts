import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CACHE_SECONDS,
  FALLBACK_ICE_SERVERS,
  getIceServers,
  ICE_TTL_SECONDS,
  NTS_TIMEOUT_MS,
  REFRESH_MARGIN_SECONDS,
  resetIceServerCache,
} from "../../src/worker/lib/twilio/ice";
import { createOwner, resetDb, Session } from "./helpers";

const TOKENS = "/2010-04-01/Accounts/AC00000000000000000000000000000000/Tokens.json";
const TURN_USER = "turn-user-6f1c2b0e9a";
const TURN_SECRET = "turn-secret-94d7a1c3e5";

/** Twilio's Tokens.json answer, in the shape the live API returns (ttl as a string, url and urls). */
const ntsToken = () => ({
  account_sid: "AC00000000000000000000000000000000",
  date_created: "Mon, 09 Nov 2026 10:00:00 +0000",
  date_updated: "Mon, 09 Nov 2026 10:00:00 +0000",
  ttl: String(ICE_TTL_SECONDS),
  username: TURN_USER,
  password: TURN_SECRET,
  ice_servers: [
    { url: "stun:global.stun.twilio.com:3478", urls: "stun:global.stun.twilio.com:3478" },
    {
      url: "turn:global.turn.twilio.com:3478?transport=udp",
      urls: "turn:global.turn.twilio.com:3478?transport=udp",
      username: TURN_USER,
      credential: TURN_SECRET,
    },
    {
      url: "turn:global.turn.twilio.com:443?transport=tcp",
      urls: "turn:global.turn.twilio.com:443?transport=tcp",
      username: TURN_USER,
      credential: TURN_SECRET,
    },
  ],
});

let calls: {
  method: string;
  url: URL;
  form: URLSearchParams;
  auth: string | null;
  signal: AbortSignal | null;
}[];
let answer: (signal: AbortSignal | null) => Response | Promise<Response>;

beforeEach(async () => {
  await resetDb();
  resetIceServerCache();
  calls = [];
  answer = () => Response.json(ntsToken(), { status: 201 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://twilio.mock") throw new Error(`unexpected fetch ${url}`);
    calls.push({
      method: init?.method ?? "GET",
      url,
      form: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
      auth: new Headers(init?.headers).get("authorization"),
      signal: init?.signal ?? null,
    });
    return answer(init?.signal ?? null);
  });
});

afterEach(() => vi.restoreAllMocks());

type Body = {
  iceServers: { urls: string; username?: string; credential?: string }[];
  ttl: number;
  source: string;
};

describe("GET /api/voice/ice-servers", () => {
  it("needs the owner's session", async () => {
    await createOwner();
    const res = await new Session().fetch("/api/voice/ice-servers");
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("asks Twilio's Network Traversal Service for 4 hour credentials with the API key", async () => {
    const owner = await createOwner();
    const res = await owner.fetch("/api/voice/ice-servers");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Body;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe(TOKENS);
    expect(calls[0]!.form.get("Ttl")).toBe("14400");
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.auth).toMatch(/^Basic /);
    expect(body.source).toBe("twilio");
    // Cached for 1 hour although the credentials last 4.
    expect(body.ttl).toBe(CACHE_SECONDS - REFRESH_MARGIN_SECONDS);
    expect(body.iceServers).toEqual([
      { urls: "stun:global.stun.twilio.com:3478" },
      {
        urls: "turn:global.turn.twilio.com:3478?transport=udp",
        username: TURN_USER,
        credential: TURN_SECRET,
      },
      { urls: "turn:global.turn.twilio.com:443?transport=tcp", username: TURN_USER, credential: TURN_SECRET },
    ]);
  });

  it("serves the cached answer until shortly before it expires", async () => {
    const owner = await createOwner();
    await owner.fetch("/api/voice/ice-servers");
    const again = (await (await owner.fetch("/api/voice/ice-servers")).json()) as Body;
    expect(calls).toHaveLength(1);
    expect(again.source).toBe("twilio");

    const start = Date.now();
    expect((await getIceServers(env, start + 10 * 60_000)).ttl).toBeLessThan(again.ttl);
    expect(calls).toHaveLength(1);
    await getIceServers(env, start + (CACHE_SECONDS - REFRESH_MARGIN_SECONDS + 5) * 1000);
    expect(calls).toHaveLength(2);
  });

  it("shares one Twilio request between concurrent callers", async () => {
    await Promise.all([getIceServers(env), getIceServers(env), getIceServers(env)]);
    expect(calls).toHaveLength(1);
  });

  it("falls back to Twilio's public STUN server, without caching it, when Twilio refuses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    answer = () => Response.json({ code: 20003, message: "Authenticate", status: 401 }, { status: 401 });
    const owner = await createOwner();
    const body = (await (await owner.fetch("/api/voice/ice-servers")).json()) as Body;
    expect(body.source).toBe("fallback");
    expect(body.iceServers).toEqual(FALLBACK_ICE_SERVERS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("status 401, code 20003"));

    answer = () => Response.json(ntsToken(), { status: 201 });
    const next = (await (await owner.fetch("/api/voice/ice-servers")).json()) as Body;
    expect(next.source).toBe("twilio");
    expect(calls).toHaveLength(2);
  });

  it("never serves an answer longer than Twilio says its credentials last", async () => {
    answer = () => Response.json({ ...ntsToken(), ttl: "1800" }, { status: 201 });
    expect((await getIceServers(env)).ttl).toBe(1800 - REFRESH_MARGIN_SECONDS);
  });

  it(
    "falls back when Twilio does not answer in time",
    async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      answer = (signal) =>
        new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
      const started = Date.now();
      const out = await getIceServers(env);
      expect(out.source).toBe("fallback");
      expect(out.iceServers).toEqual(FALLBACK_ICE_SERVERS);
      expect(Date.now() - started).toBeGreaterThanOrEqual(NTS_TIMEOUT_MS - 100);
    },
    NTS_TIMEOUT_MS + 5_000,
  );

  it("falls back when the network fails or Twilio sends no usable server", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    answer = () => {
      throw new TypeError("network down");
    };
    expect((await getIceServers(env)).source).toBe("fallback");
    answer = () =>
      Response.json({ ...ntsToken(), ice_servers: [{ urls: "http://not-ice" }] }, { status: 201 });
    expect((await getIceServers(env)).source).toBe("fallback");
  });

  it("never writes the TURN credentials to the logs", async () => {
    const logged: unknown[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, level).mockImplementation((...args) => void logged.push(...args));
    const owner = await createOwner();
    await owner.fetch("/api/voice/ice-servers");
    answer = () => Response.json({ code: 20003, message: "Authenticate" }, { status: 401 });
    resetIceServerCache();
    await owner.fetch("/api/voice/ice-servers");
    const text = JSON.stringify(logged);
    expect(text).not.toContain(TURN_USER);
    expect(text).not.toContain(TURN_SECRET);
    expect(text).not.toContain("test-api-key-secret");
  });
});
