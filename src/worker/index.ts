/**
 * The Hono app behind /api/*. src/server.ts sends every /api request here; everything else is a page.
 *
 * Secure by default: every /api route requires the owner's session and, for state-changing methods, a
 * same-origin Origin header. The only exceptions are listed in PUBLIC_API below. A new route file only needs
 * `app.route("/api/<name>", router)` and is protected without further work.
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { buildId } from "../shared/build";
import { AUTH_BASE_PATH } from "./auth";
import { ApiError } from "./lib/errors";
import { bootstrap, requireOwner, sameOrigin, session } from "./middleware";
import { authConfig, oidcEnabled } from "./oidc";
import { account } from "./routes/account";
import { billing } from "./routes/billing";
import { callsRouter } from "./routes/calls";
import { contactsRouter } from "./routes/contacts";
import { live } from "./routes/live";
import { messagesApi } from "./routes/messages";
import { missedCallTextApi } from "./routes/missed-call-text";
import { numbers } from "./routes/numbers";
import { preferences } from "./routes/preferences";
import { push } from "./routes/push";
import { quickRepliesApi } from "./routes/quick-replies";
import { status } from "./routes/status";
import { twilio } from "./routes/twilio";
import { voice } from "./routes/voice";
import { voicemailsRouter } from "./routes/voicemails";
import type { AppEnv } from "./types";

export { OwnerHub } from "./durable/owner-hub";

/** Paths reachable without a session. Twilio webhooks verify Twilio's signature instead (routes/twilio.ts). */
const PUBLIC_API = /^\/api\/(health$|setup$|auth-config$|auth\/|twilio\/)/;
/** Paths that skip our Origin check: Better Auth checks Origin itself, Twilio sends none. */
const NO_ORIGIN_CHECK = /^\/api\/(auth\/|twilio\/)/;

const app = new Hono<AppEnv>();

const headers = secureHeaders({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: undefined });
// A WebSocket upgrade answer comes from the Durable Object with immutable headers, so it is passed through as is.
app.use("*", async (c, next) =>
  c.req.header("upgrade")?.toLowerCase() === "websocket" ? next() : headers(c, next),
);
app.use("/api/*", bootstrap);
app.use("/api/*", async (c, next) => (NO_ORIGIN_CHECK.test(c.req.path) ? next() : sameOrigin(c, next)));
app.use("/api/*", async (c, next) => (c.req.path.startsWith("/api/twilio/") ? next() : session(c, next)));
app.use("/api/*", async (c, next) => (PUBLIC_API.test(c.req.path) ? next() : requireOwner(c, next)));

app.get("/api/health", (c) => c.json({ ok: true, build: buildId() }));

/** Public: whether the login and setup screens show the SSO button, and its label. Booleans and text only. */
app.get("/api/auth-config", (c) => {
  c.header("cache-control", "no-store");
  return c.json(authConfig(c.env));
});

/** The SSO routes exist only when SSO is configured. */
const OIDC_PATHS = /^\/api\/auth\/(callback\/oidc|sign-in\/social)$/;

app.on(["GET", "POST"], `${AUTH_BASE_PATH}/*`, (c) => {
  if (!oidcEnabled(c.env) && OIDC_PATHS.test(c.req.path)) throw new ApiError(404, "not_found", "Not found");
  const auth = c.get("auth");
  if (!auth) throw new ApiError(503, "not_configured", "BETTER_AUTH_SECRET is not set");
  return auth.handler(c.req.raw);
});

app.route("/api", account);
app.route("/api/calls", callsRouter);
app.route("/api/contacts", contactsRouter);
app.route("/api/live", live);
app.route("/api/push", push);
app.route("/api/numbers", numbers);
app.route("/api/preferences", preferences);
app.route("/api/billing", billing);
app.route("/api/status", status);
app.route("/api/messages", messagesApi);
app.route("/api/missed-call-text", missedCallTextApi);
app.route("/api/quick-replies", quickRepliesApi);
app.route("/api/twilio", twilio);
app.route("/api/voice", voice);
app.route("/api/voicemails", voicemailsRouter);

app.notFound((c) => c.json({ error: "not_found", message: "Not found" }, 404));

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.code, message: err.message }, err.status);
  if (err instanceof HTTPException) return c.json({ error: "http_error", message: err.message }, err.status);
  console.error("unhandled", { requestId: c.get("requestId"), path: c.req.path, error: String(err) });
  return c.json({ error: "internal", message: "Something went wrong" }, 500);
});

export default app;
