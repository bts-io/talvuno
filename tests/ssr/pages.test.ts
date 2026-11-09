import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createOwner, resetDb, Session } from "../integration/helpers";

beforeEach(resetDb);

const page = async (s: Session, path: string) => {
  const res = await s.fetch(path, { origin: null });
  return { res, html: res.status === 200 ? await res.text() : "" };
};

describe("server-rendered pages", () => {
  it("sends a fresh install to /setup", async () => {
    const s = new Session();
    const { res } = await page(s, "/keypad");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toMatch(/\/setup$/);
    const setup = await page(s, "/setup");
    expect(setup.html).toContain("Set up Talvuno");
    expect(setup.html).toContain("Calls only ring while Talvuno is open in the foreground");
    expect(setup.res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("sends a signed-out visitor to /login once an owner exists", async () => {
    await createOwner();
    const s = new Session();
    const { res } = await page(s, "/messages");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toMatch(/\/login\?next=/);
    expect((await page(s, "/login")).html).toContain("Sign in to Talvuno");
    expect((await page(s, "/setup")).res.status).toBe(307);
  });

  it("renders the tab shell for the owner", async () => {
    const s = await createOwner();
    const { html } = await page(s, "/keypad");
    for (const tab of ["Keypad", "Recents", "Messages", "Contacts", "Settings"]) expect(html).toContain(tab);
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(html).toMatch(/<html[^>]*lang="en"[^>]*dir="ltr"/);
  });

  it("sends / to the keypad", async () => {
    const s = await createOwner();
    const { res } = await page(s, "/");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toMatch(/\/keypad$/);
  });
});

describe("content security policy", () => {
  const nonceOf = (res: Response) =>
    res.headers.get("content-security-policy")?.match(/'nonce-([^']+)'/)?.[1];

  it("is on every page with a nonce that differs per request", async () => {
    const fresh = new Session();
    const a = await page(fresh, "/setup");
    const b = await page(fresh, "/setup");
    const csp = a.res.headers.get("content-security-policy") ?? "";
    for (const d of [
      "default-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "form-action 'self'",
      "'strict-dynamic'",
      "wss://*.twilio.com",
      "wss://talvuno.test",
    ])
      expect(csp).toContain(d);
    expect(nonceOf(a.res)).toBeTruthy();
    expect(nonceOf(a.res)).not.toBe(nonceOf(b.res));

    const owner = await createOwner();
    expect(nonceOf((await page(new Session(), "/login")).res)).toBeTruthy();
    expect(nonceOf((await page(owner, "/keypad")).res)).toBeTruthy();
  });

  it("puts the request's nonce on every script and modulepreload link", async () => {
    const { res, html } = await page(new Session(), "/setup");
    const nonce = nonceOf(res);
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.some((m) => /\bsrc=/.test(m[1] ?? ""))).toBe(true);
    expect(scripts.some((m) => !/\bsrc=/.test(m[1] ?? ""))).toBe(true);
    for (const m of scripts) expect(m[1]).toContain(`nonce="${nonce}"`);
    const preloads = [...html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*>/g)];
    expect(preloads.length).toBeGreaterThan(0);
    for (const m of preloads) expect(m[0]).toContain(`nonce="${nonce}"`);
  });

  it("leaves /api JSON responses alone", async () => {
    const res = await new Session().fetch("/api/health", { origin: null });
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("content-security-policy-report-only")).toBeNull();
  });
});

describe("brand images", () => {
  // SELF.fetch skips the static assets layer, so check the two halves of what serves them: the file is in the
  // asset bundle, and the config keeps /brand/* away from the Worker (run_worker_first sends everything else to it).
  it("excludes /brand/* from run_worker_first in the built config", async () => {
    const { default: config } = await import("../../dist/server/wrangler.json");
    expect(config.assets.run_worker_first).toContain("!/brand/*");
  });

  it.each([
    ["/brand/talvuno-mascot.webp", "image/webp"],
    ["/brand/talvuno-wordmark.svg", "image/svg+xml"],
    ["/brand/talvuno-wordmark-dark.svg", "image/svg+xml"],
  ])("serves %s from the asset bundle as an image", async (path, type) => {
    const res = await env.ASSETS.fetch(new URL(path, "https://talvuno.test"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(type);
  });
});
