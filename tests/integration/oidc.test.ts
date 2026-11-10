import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOwner, OWNER, resetDb, Session } from "./helpers";

const ISSUER = "https://idp.test";
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;

type Profile = { sub: string; email?: string; email_verified?: boolean; name?: string };
let profile: Profile;
const e = env as unknown as Record<string, unknown>;

function enableOidc() {
  e.OIDC_DISCOVERY_URL = DISCOVERY;
  e.OIDC_CLIENT_ID = "talvuno-client";
  e.OIDC_CLIENT_SECRET = "talvuno-secret";
}
function disableOidc() {
  for (const k of [
    "SOURCE_URL",
    "OIDC_DISCOVERY_URL",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_BUTTON_LABEL",
  ])
    delete e[k];
}

/** A mock identity provider: discovery, token and userinfo. Everything else goes to the real fetch. */
function mockProvider() {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === DISCOVERY)
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`,
        id_token_signing_alg_values_supported: ["RS256"],
      });
    if (url.href === `${ISSUER}/token`)
      return Response.json({ access_token: "at", token_type: "Bearer", expires_in: 3600 });
    if (url.href === `${ISSUER}/userinfo`) return Response.json(profile);
    return real(input, init);
  });
}

/** Runs the browser flow: start at our API, "visit" the provider, come back to the callback. */
async function ssoSignIn(s: Session, page = "/login") {
  const start = await s.post<{ url: string }>("/api/auth/sign-in/social", {
    provider: "oidc",
    callbackURL: "/keypad",
    errorCallbackURL: `${page}?sso=failed`,
  });
  const auth = new URL(start.url);
  expect(auth.origin + auth.pathname).toBe(`${ISSUER}/authorize`);
  expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
  expect(auth.searchParams.get("scope")).toContain("openid");
  expect(auth.searchParams.get("redirect_uri")).toBe("https://talvuno.test/api/auth/callback/oidc");
  const cb = await s.fetch(`/api/auth/callback/oidc?code=abc&state=${auth.searchParams.get("state")}`, {
    origin: null,
  });
  return new URL(cb.headers.get("location") ?? "", "https://talvuno.test");
}

const count = async (table: string) =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n;

beforeEach(async () => {
  await resetDb();
  await env.DB.prepare("DELETE FROM account").run();
  profile = { sub: "u1", email: OWNER.email, email_verified: true, name: "Owner" };
  enableOidc();
  mockProvider();
});
afterEach(() => {
  vi.restoreAllMocks();
  disableOidc();
});

describe("auth-config", () => {
  it("shows the button with the default label when configured", async () => {
    expect(await new Session().get("/api/auth-config")).toEqual({
      oidc: true,
      oidcLabel: "Sign in with SSO",
      sourceUrl: "https://github.com/bts-io/talvuno",
    });
    e.OIDC_BUTTON_LABEL = "Sign in with Authentik";
    expect((await new Session().get("/api/auth-config")).oidcLabel).toBe("Sign in with Authentik");
  });

  it("uses the default source link when SOURCE_URL is unset", async () => {
    delete e.SOURCE_URL;
    expect((await new Session().get("/api/auth-config")).sourceUrl).toBe("https://github.com/bts-io/talvuno");
  });

  it("returns a custom SOURCE_URL", async () => {
    e.SOURCE_URL = "https://git.example.org/me/talvuno-fork";
    expect((await new Session().get("/api/auth-config")).sourceUrl).toBe(
      "https://git.example.org/me/talvuno-fork",
    );
  });

  it("falls back to the default for any scheme other than http and https", async () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://example.org/x", "not a url"]) {
      e.SOURCE_URL = bad;
      expect((await new Session().get("/api/auth-config")).sourceUrl).toBe(
        "https://github.com/bts-io/talvuno",
      );
    }
  });

  it("shows no button, and the SSO routes answer 404, when any setting is missing", async () => {
    delete e.OIDC_CLIENT_SECRET;
    const s = new Session();
    expect(await s.get("/api/auth-config")).toMatchObject({ oidc: false });
    const start = await s.fetch("/api/auth/sign-in/social", {
      method: "POST",
      json: { provider: "oidc", callbackURL: "/keypad" },
    });
    expect(start.status).toBe(404);
    const cb = await s.fetch("/api/auth/callback/oidc?code=a&state=b", { origin: null });
    expect(cb.status).toBe(404);
  });
});

describe("single sign-on", () => {
  it("signs the owner in when the verified email matches (case-insensitive)", async () => {
    await createOwner();
    profile.email = OWNER.email.toUpperCase();
    const s = new Session();
    const dest = await ssoSignIn(s);
    expect(dest.pathname).toBe("/keypad");
    expect(await s.get("/api/me")).toMatchObject({ email: OWNER.email });
    expect(await count("user")).toBe(1);
    expect(await count("account")).toBe(2); // credential + oidc
  });

  it("refuses a different email and creates nothing", async () => {
    await createOwner();
    profile.email = "intruder@talvuno.test";
    const s = new Session();
    const dest = await ssoSignIn(s);
    expect(dest.pathname).toBe("/login");
    expect(dest.searchParams.get("sso")).toBe("failed");
    await s.get("/api/me", 401);
    expect(await count("user")).toBe(1);
    expect(await count("account")).toBe(1);
  });

  it("refuses an unverified email even when it matches the owner", async () => {
    await createOwner();
    profile.email_verified = false;
    const s = new Session();
    const dest = await ssoSignIn(s);
    expect(dest.searchParams.get("sso")).toBe("failed");
    await s.get("/api/me", 401);
    expect(await count("account")).toBe(1);
  });

  it("refuses a profile with no email", async () => {
    await createOwner();
    delete profile.email;
    const dest = await ssoSignIn(new Session());
    expect(dest.searchParams.get("sso")).toBe("failed");
  });

  it("refuses SSO before an owner exists and creates nothing", async () => {
    for (const page of ["/login", "/setup"]) {
      const s = new Session();
      const dest = await ssoSignIn(s, page);
      expect(dest.pathname).toBe(page);
      expect(dest.searchParams.get("sso")).toBe("failed");
      await s.get("/api/me", 401);
    }
    expect(await count("user")).toBe(0);
    expect(await count("account")).toBe(0);
    expect(await count("owner_claim")).toBe(0);
    expect(await new Session().get("/api/setup")).toEqual({ needed: true });
  });

  it("keeps public sign-up closed", async () => {
    const res = await new Session().fetch("/api/auth/sign-up/email", {
      method: "POST",
      json: { ...OWNER, name: "x" },
    });
    expect(res.status).toBe(404);
  });
});
