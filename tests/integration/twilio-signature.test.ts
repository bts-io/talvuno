import { env, SELF } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeTwilioSignature, twilioSignature } from "../../src/worker/lib/twilio/signature";
import type { AppEnv } from "../../src/worker/types";
import { signedTwilioPost } from "./twilio-helpers";

const PARAMS = { CallSid: "CA0123456789abcdef0123456789abcdef", From: "+14155552671", To: "+14155550100" };
// No handler lives at this path, so a request that passes the signature check ends in the router's 404.
const PATH = "/api/twilio/probe?x=1";

afterEach(() => vi.restoreAllMocks());

describe("twilioSignature middleware", () => {
  it("lets a correctly signed request through, without a session or Origin", async () => {
    const res = await signedTwilioPost(PATH, PARAMS);
    expect(res.status).toBe(404);
  });

  it("answers 403 to a missing signature and logs without secrets", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await signedTwilioPost(PATH, PARAMS, { signature: null });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("missing signature");
    expect(logged).not.toContain("test-auth-token");
    expect(logged).not.toContain("+14155552671");
    expect(logged).not.toContain("x=1");
  });

  it("answers 403 to a signature made with another token", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await signedTwilioPost(PATH, PARAMS, { authToken: "someone-else" });
    expect(res.status).toBe(403);
  });

  it("answers 403 when the body differs from what was signed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = await signedTwilioPost(PATH, PARAMS);
    expect(good.status).toBe(404);
    const sig = await computeTwilioSignature("test-auth-token", `https://talvuno.test${PATH}`, PARAMS);
    const res = await SELF.fetch(`https://talvuno.test${PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
      body: new URLSearchParams({ ...PARAMS, From: "+14155559999" }).toString(),
    });
    expect(res.status).toBe(403);
  });

  it("ignores Host and X-Forwarded-Host when building the URL", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const forged = await computeTwilioSignature("test-auth-token", `https://evil.test${PATH}`, PARAMS);
    const res = await SELF.fetch(`https://talvuno.test${PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": forged,
        "x-forwarded-host": "evil.test",
      },
      body: new URLSearchParams(PARAMS).toString(),
    });
    expect(res.status).toBe(403);
  });

  it("guards GET requests too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await SELF.fetch("https://talvuno.test/api/twilio/probe");
    expect(res.status).toBe(403);
  });
});

describe("after the middleware", () => {
  it("handlers can still parse the form body", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", twilioSignature());
    app.post("/api/twilio/echo", async (c) => c.json(await c.req.parseBody()));
    const url = "https://talvuno.test/api/twilio/echo";
    const res = await app.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": await computeTwilioSignature("test-auth-token", url, PARAMS),
        },
        body: new URLSearchParams(PARAMS).toString(),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PARAMS);
  });

  it("answers 403 when TWILIO_AUTH_TOKEN is not configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = new Hono<AppEnv>();
    app.use("*", twilioSignature());
    app.post("/api/twilio/echo", (c) => c.text("reached"));
    const url = "https://talvuno.test/api/twilio/echo";
    const res = await app.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": await computeTwilioSignature("anything", url, PARAMS),
        },
        body: new URLSearchParams(PARAMS).toString(),
      },
      { ...env, TWILIO_AUTH_TOKEN: undefined },
    );
    expect(res.status).toBe(403);
    expect(JSON.stringify(warn.mock.calls)).toContain("auth token not configured");
  });
});
