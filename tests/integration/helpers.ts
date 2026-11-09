import { env, SELF } from "cloudflare:test";
import { expect } from "vitest";

/** The deployment origin the tests run under (vitest.config.ts sets PUBLIC_URL). */
export const BASE = new URL(env.PUBLIC_URL).origin;
/** The setup token vitest.config.ts configures. */
export const SETUP_TOKEN = env.SETUP_TOKEN!;
export const OWNER = { name: "Owner", email: "owner@talvuno.test", password: "correct horse battery" };

/**
 * Cookie-jar client that talks to the Worker through SELF.fetch, sending this deployment's Origin like a
 * browser on the app would. Pass `origin: null` in init headers to drop it.
 */
export class Session {
  cookies = new Map<string, string>();
  setCookieHeaders: string[] = [];

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async fetch(path: string, init: RequestInit & { json?: unknown; origin?: string | null } = {}) {
    const headers = new Headers(init.headers);
    if (init.origin !== null) headers.set("origin", init.origin ?? BASE);
    headers.set("user-agent", "vitest");
    if (this.cookies.size) headers.set("cookie", this.cookieHeader());
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    const res = await SELF.fetch(new URL(path, BASE).toString(), {
      ...init,
      headers,
      body,
      redirect: "manual",
    });
    for (const c of res.headers.getSetCookie()) {
      this.setCookieHeaders.push(c);
      const [pair, ...attrs] = c.split(";");
      const eq = pair!.indexOf("=");
      const k = pair!.slice(0, eq).trim();
      const v = pair!.slice(eq + 1);
      if (attrs.some((a) => /max-age=0/i.test(a)) || v === "") this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    return res;
  }

  async json<T = any>(method: string, path: string, json?: unknown, expectStatus = 200): Promise<T> {
    const res = await this.fetch(path, { method, json });
    const text = await res.text();
    expect(res.status, `${method} ${path} -> ${text.slice(0, 300)}`).toBe(expectStatus);
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }
  get<T = any>(path: string, expectStatus?: number) {
    return this.json<T>("GET", path, undefined, expectStatus);
  }
  post<T = any>(path: string, json?: unknown, expectStatus?: number) {
    return this.json<T>("POST", path, json ?? {}, expectStatus);
  }
}

/**
 * Empties every table. History rows go first because message and call foreign keys restrict deletes; deleting
 * users then cascades to the remaining owner-scoped rows.
 */
export async function resetDb() {
  await env.DB.batch(
    [
      "messages",
      "calls",
      "conversations",
      "owner_claim",
      "user",
      "rate_limit",
      "verification",
      "webhook_events",
      "audit_events",
    ].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
}

/** Runs first-run setup and returns a signed-in session for the owner. */
export async function createOwner(): Promise<Session & { userId: string }> {
  const s = new Session();
  const me = await s.post<{ id: string }>("/api/setup", { ...OWNER, setupToken: SETUP_TOKEN }, 201);
  return Object.assign(s, { userId: me.id });
}
