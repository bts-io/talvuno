import { createMiddleware } from "hono/factory";
import { createAuth, publicOrigin } from "./auth";
import { createDb } from "./db";
import { ApiError } from "./lib/errors";
import type { AppEnv } from "./types";

/** Per-request context: Drizzle, Better Auth, a request id for logs. */
export const bootstrap = createMiddleware<AppEnv>(async (c, next) => {
  c.set("db", createDb(c.env.DB));
  c.set("auth", createAuth(c.env));
  c.set("requestId", c.req.header("cf-ray") ?? crypto.randomUUID());
  c.set("user", null);
  c.set("session", null);
  await next();
});

/**
 * Reads the session cookie, if any. Never rejects; requireOwner does that. Better Auth extends a session that
 * is past `updateAge` and answers with a fresh Set-Cookie; those headers are added to the response, so the
 * browser's cookie lifetime follows the stored session (the SSR bridge in src/server.ts forwards them too).
 */
export const session = createMiddleware<AppEnv>(async (c, next) => {
  const auth = c.get("auth");
  let refreshed: string[] = [];
  if (auth) {
    const result = await auth.api
      .getSession({ headers: c.req.raw.headers, returnHeaders: true })
      .catch(() => null);
    if (result?.response) {
      c.set("user", result.response.user);
      c.set("session", result.response.session);
      refreshed = result.headers.getSetCookie();
    }
  }
  await next();
  // A WebSocket upgrade answer has immutable headers, and a route that sets the same cookie itself (sign-in,
  // sign-out) must not be overridden by a refresh computed from the old cookie.
  if (c.res.status === 101) return;
  const own = new Set(c.res.headers.getSetCookie().map((sc) => sc.split("=")[0]));
  for (const cookie of refreshed)
    if (!own.has(cookie.split("=")[0])) c.res.headers.append("set-cookie", cookie);
});

/**
 * Only the owner gets past this. There is exactly one account per deployment (src/worker/auth.ts), so a
 * valid session is the owner's session.
 */
export const requireOwner = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get("user")) throw new ApiError(401, "unauthorized", "Sign in first");
  await next();
});

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF guard for cookie-authenticated routes: state-changing requests must carry an Origin header naming this
 * deployment. Browsers always send Origin on cross-origin and on non-GET fetches, so a forged form post or
 * fetch from another site is refused even before SameSite=Lax would stop its cookie. WebSocket upgrades are
 * GETs, so /api/live checks Origin itself (sameOriginUpgrade).
 */
export const sameOrigin = createMiddleware<AppEnv>(async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method) && c.req.header("origin") !== publicOrigin(c.env))
    throw new ApiError(403, "cross_site", "Cross-site request refused");
  await next();
});

/** Origin check for WebSocket upgrades (cross-site WebSocket hijacking). */
export const sameOriginUpgrade = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.header("origin") !== publicOrigin(c.env))
    throw new ApiError(403, "cross_site", "Cross-site request refused");
  await next();
});
