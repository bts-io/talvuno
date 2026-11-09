import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../../src/worker/auth";
import app from "../../src/worker/index";
import { BASE, createOwner, OWNER, resetDb, SETUP_TOKEN, Session } from "./helpers";

const SETUP = { ...OWNER, setupToken: SETUP_TOKEN };

beforeEach(resetDb);

describe("health", () => {
  it("is public and names the build", async () => {
    const s = new Session();
    expect(await s.get("/api/health")).toEqual({ ok: true, build: "dev" });
  });
});

describe("first-run setup", () => {
  it("reports setup as needed until an owner exists", async () => {
    const s = new Session();
    expect(await s.get("/api/setup")).toEqual({ needed: true });
    await createOwner();
    expect(await s.get("/api/setup")).toEqual({ needed: false });
  });

  it("creates the owner, signs them in with a secure HttpOnly SameSite cookie", async () => {
    const s = await createOwner();
    const cookie = s.setCookieHeaders.find((c) => c.includes("session_token"))!;
    expect(cookie).toMatch(/^__Secure-talvuno\.session_token=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(await s.get("/api/me")).toMatchObject({ name: OWNER.name, email: OWNER.email });
    const audit = await env.DB.prepare("SELECT action FROM audit_events").all();
    expect(audit.results).toEqual([{ action: "owner.setup" }]);
  });

  it("works once: a second setup is refused and no second account exists", async () => {
    await createOwner();
    const other = new Session();
    await other.post("/api/setup", { ...SETUP, email: "intruder@talvuno.test" }, 409);
    const users = await env.DB.prepare("SELECT count(*) AS n FROM user").first<{ n: number }>();
    expect(users?.n).toBe(1);
  });

  it("lets only one of two racing setups win", async () => {
    const [a, b] = await Promise.all([
      new Session().fetch("/api/setup", { method: "POST", json: SETUP }),
      new Session().fetch("/api/setup", { method: "POST", json: { ...SETUP, email: "b@talvuno.test" } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const users = await env.DB.prepare("SELECT count(*) AS n FROM user").first<{ n: number }>();
    expect(users?.n).toBe(1);
  });

  it("rejects a weak password", async () => {
    await new Session().post("/api/setup", { ...SETUP, password: "short" }, 400);
  });

  it("refuses a cross-site setup post", async () => {
    const s = new Session();
    const res = await s.fetch("/api/setup", { method: "POST", json: SETUP, origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });
});

describe("setup token", () => {
  const userCount = async () =>
    (await env.DB.prepare("SELECT count(*) AS n FROM user").first<{ n: number }>())?.n;

  it("refuses a wrong token", async () => {
    const res = await new Session().fetch("/api/setup", {
      method: "POST",
      json: { ...OWNER, setupToken: `${SETUP_TOKEN}x` },
    });
    expect(res.status).toBe(403);
    expect(await userCount()).toBe(0);
  });

  it("refuses a missing or empty token", async () => {
    for (const json of [OWNER, { ...OWNER, setupToken: "" }]) {
      const res = await new Session().fetch("/api/setup", { method: "POST", json });
      expect(res.status).toBe(403);
    }
    expect(await userCount()).toBe(0);
  });

  it("refuses setup with 503 when SETUP_TOKEN is not configured", async () => {
    const req = new Request(`${BASE}/api/setup`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ ...OWNER, setupToken: SETUP_TOKEN }),
    });
    const res = await app.fetch(req, { ...env, SETUP_TOKEN: undefined });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ message: "SETUP_TOKEN not configured" });
    expect(await userCount()).toBe(0);
  });

  it("accepts the correct token", async () => {
    await new Session().post("/api/setup", SETUP, 201);
    expect(await userCount()).toBe(1);
  });
});

describe("failed sign-up", () => {
  it("releases the owner claim when sign-up fails after the claim insert, so setup can be retried", async () => {
    await env.DB.exec(
      "CREATE TRIGGER fail_user_insert BEFORE INSERT ON user BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    try {
      const res = await new Session().fetch("/api/setup", { method: "POST", json: SETUP });
      expect(res.status).toBeGreaterThanOrEqual(400);
      const claims = await env.DB.prepare("SELECT count(*) AS n FROM owner_claim").first<{ n: number }>();
      expect(claims?.n).toBe(0);
    } finally {
      await env.DB.exec("DROP TRIGGER fail_user_insert");
    }
    await new Session().post("/api/setup", SETUP, 201);
  });
});

describe("small guards", () => {
  it("disables the auth rate limit only for RATE_LIMIT_DISABLED=true", () => {
    const enabled = (v: string | undefined) =>
      createAuth({ ...env, RATE_LIMIT_DISABLED: v })!.options.rateLimit?.enabled;
    expect(enabled("true")).toBe(false);
    for (const v of [undefined, "", "false", "0", "no", "TRUE"]) expect(enabled(v)).toBe(true);
  });

  it("skips secure headers only for a real WebSocket upgrade", async () => {
    const s = new Session();
    const plain = await s.fetch("/api/health");
    expect(plain.headers.get("x-content-type-options")).toBe("nosniff");
    const other = await s.fetch("/api/health", { headers: { upgrade: "h2c" } });
    expect(other.headers.get("x-content-type-options")).toBe("nosniff");
    const ws = await s.fetch("/api/health", { headers: { upgrade: "WebSocket" } });
    expect(ws.headers.get("x-content-type-options")).toBeNull();
  });
});

describe("session refresh", () => {
  const COOKIE = "__Secure-talvuno.session_token";
  const expiry = async () =>
    (await env.DB.prepare("SELECT expires_at AS t FROM session").first<{ t: number }>())!.t;

  it("sets a fresh cookie on a session older than updateAge, and not on a young one", async () => {
    const s = await createOwner();
    const young = await s.fetch("/api/me");
    expect(young.headers.getSetCookie().some((c) => c.startsWith(COOKIE))).toBe(false);

    // Make the session look two days old (30 day lifetime, one day updateAge).
    const old = Date.now() + 28 * 24 * 3600 * 1000;
    await env.DB.prepare("UPDATE session SET expires_at = ?").bind(old).run();
    const res = await s.fetch("/api/me");
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(COOKIE));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Max-Age=/i);
    expect(await expiry()).toBeGreaterThan(old);
  });

  it("does not override the cookie a sign-out clears", async () => {
    const s = await createOwner();
    await env.DB.prepare("UPDATE session SET expires_at = ?")
      .bind(Date.now() + 28 * 24 * 3600 * 1000)
      .run();
    const res = await s.fetch("/api/auth/sign-out", { method: "POST", json: {} });
    expect(res.status).toBe(200);
    const mine = res.headers.getSetCookie().filter((c) => c.startsWith(COOKIE));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatch(/Max-Age=0/i);
  });
});

describe("owner_claim", () => {
  it("makes Better Auth refuse a sign-up once the claim row exists", async () => {
    await env.DB.prepare(
      "INSERT INTO owner_claim (id, email, claimed_at) VALUES (1, 'first@talvuno.test', 0)",
    ).run();
    const auth = createAuth(env)!;
    await expect(
      auth.api.signUpEmail({
        body: { name: "Second", email: "second@talvuno.test", password: OWNER.password },
      }),
    ).rejects.toThrow(/already has an owner/);
    const users = await env.DB.prepare("SELECT count(*) AS n FROM user").first<{ n: number }>();
    expect(users?.n).toBe(0);
  });
});

describe("sign-up is closed", () => {
  it("answers 404 on Better Auth's public sign-up", async () => {
    const s = new Session();
    const res = await s.fetch("/api/auth/sign-up/email", {
      method: "POST",
      json: { ...OWNER, email: "new@talvuno.test" },
    });
    expect(res.status).toBe(404);
  });
});

describe("sign in and out", () => {
  it("signs the owner in with email and password, then out", async () => {
    await createOwner();
    const s = new Session();
    await s.get("/api/me", 401);
    await s.post("/api/auth/sign-in/email", { email: OWNER.email, password: OWNER.password });
    await s.get("/api/me");
    await s.post("/api/auth/sign-out", {});
    await s.get("/api/me", 401);
  });

  it("refuses a wrong password", async () => {
    await createOwner();
    const s = new Session();
    await s.post("/api/auth/sign-in/email", { email: OWNER.email, password: "wrong password!!" }, 401);
  });

  it("rate limits sign-in attempts (stored in D1, so it holds across isolates)", async () => {
    await createOwner();
    const s = new Session();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await s.fetch("/api/auth/sign-in/email", {
        method: "POST",
        json: { email: OWNER.email, password: "wrong password!!" },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every((st) => st === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("refuses a sign-in from another origin", async () => {
    await createOwner();
    const s = new Session();
    const res = await s.fetch("/api/auth/sign-in/email", {
      method: "POST",
      json: { email: OWNER.email, password: OWNER.password },
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
  });
});

describe("requireOwner and CSRF", () => {
  it("guards unknown /api routes too (secure by default)", async () => {
    const res = await new Session().fetch("/api/anything");
    expect(res.status).toBe(401);
  });

  it("refuses a state-changing request without our Origin even with a valid session", async () => {
    const s = await createOwner();
    const res = await s.fetch("/api/me", { method: "POST", json: {}, origin: null });
    expect(res.status).toBe(403);
  });

  it("leaves /api/twilio/* to Twilio signature checks, not the session", async () => {
    const res = await new Session().fetch("/api/twilio/voice", { method: "POST", origin: null });
    // The signature check answers "forbidden"; the session guard would give 401 and the Origin guard "cross_site".
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
  });
});
