/**
 * X-Twilio-Signature validation, following Twilio's documented algorithm and the `twilio` npm package
 * (lib/webhooks/webhooks.js): HMAC-SHA1 with the auth token over the full URL Twilio called, followed by each
 * POST field sorted by name with name and value concatenated, base64 encoded.
 *
 * The URL is rebuilt from PUBLIC_URL plus the request's path and query. Host and X-Forwarded-* headers are
 * never trusted, so a request cannot make us sign a URL of its choosing.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types";

export const SIGNATURE_HEADER = "x-twilio-signature";

export type TwilioParams = Record<string, string | string[]>;

const encoder = new TextEncoder();

function toBase64(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

/** The string Twilio signs: the URL, then every field name and value, names sorted, repeated values sorted. */
export function signingString(url: string, params: TwilioParams): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    const value = params[key]!;
    if (Array.isArray(value)) for (const v of [...new Set(value)].sort()) data += key + v;
    else data += key + value;
  }
  return data;
}

/** Base64 HMAC-SHA1 of the signing string, keyed with the auth token. */
export async function computeTwilioSignature(
  authToken: string,
  url: string,
  params: TwilioParams,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  return toBase64(await crypto.subtle.sign("HMAC", key, encoder.encode(signingString(url, params))));
}

/** Constant-time string comparison (length leaks, content does not). */
export function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/**
 * The URL Twilio called, built from the configured origin plus the path and query of the request. Returns the
 * variants with and without the scheme's default port, because Twilio may sign either (the npm package checks
 * both too).
 */
export function publicUrlCandidates(publicUrl: string, requestUrl: string): string[] {
  const origin = new URL(publicUrl);
  const req = new URL(requestUrl);
  // The runtime hands us an already serialized URL, so pathname and search are the bytes Twilio requested.
  const pathAndQuery = req.pathname + req.search;
  const base = `${origin.protocol}//${origin.hostname}`;
  const defaultPort = origin.protocol === "https:" ? "443" : "80";
  const port = origin.port || defaultPort;
  const urls = [`${base}:${port}${pathAndQuery}`];
  if (port === defaultPort) urls.unshift(`${base}${pathAndQuery}`);
  return urls;
}

async function sha256Hex(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(body));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Form fields of a urlencoded body, repeated names kept as arrays. */
export function formParams(body: string): TwilioParams {
  const out: TwilioParams = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const prev = out[k];
    if (prev === undefined) out[k] = v;
    else out[k] = Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

/**
 * Checks a request against the auth token. Form posts sign the fields; JSON bodies (Twilio's `bodySHA256`
 * variant) sign the URL alone and carry the body's SHA-256 in the query.
 */
export async function verifyTwilioRequest(
  authToken: string,
  publicUrl: string,
  request: { url: string; signature: string | undefined; contentType: string | undefined; body: string },
): Promise<boolean> {
  if (!request.signature) return false;
  const query = new URL(request.url).searchParams;
  const bodyHash = query.get("bodySHA256");
  const isForm = (request.contentType ?? "").toLowerCase().includes("application/x-www-form-urlencoded");
  let params: TwilioParams = {};
  if (bodyHash !== null) {
    if (!safeEqual(bodyHash, await sha256Hex(request.body))) return false;
  } else if (isForm) {
    params = formParams(request.body);
  } else if (request.body !== "") {
    // A body that is neither a form nor covered by bodySHA256 is not signed; refuse it.
    return false;
  }
  for (const url of publicUrlCandidates(publicUrl, request.url)) {
    if (safeEqual(request.signature, await computeTwilioSignature(authToken, url, params))) return true;
  }
  return false;
}

/** Path without its query, for logs (queries may carry numbers). */
const logPath = (url: string) => new URL(url).pathname;

/**
 * Rejects every request that is not signed by Twilio with this account's auth token: 403, with one log line
 * that names the reason and the path but never the signature, token or body. Applied to the whole
 * /api/twilio router. Handlers can still read the body (`c.req.parseBody()`), because Hono caches it.
 */
export function twilioSignature(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = c.env.TWILIO_AUTH_TOKEN;
    const reject = (reason: string) => {
      console.warn("twilio webhook rejected", {
        reason,
        path: logPath(c.req.url),
        requestId: c.get("requestId"),
      });
      return c.json({ error: "forbidden", message: "Invalid Twilio signature" }, 403);
    };
    if (!token) return reject("auth token not configured");
    if (!c.env.PUBLIC_URL) return reject("PUBLIC_URL not configured");
    const signature = c.req.header(SIGNATURE_HEADER);
    if (!signature) return reject("missing signature");
    const ok = await verifyTwilioRequest(token, c.env.PUBLIC_URL, {
      url: c.req.url,
      signature,
      contentType: c.req.header("content-type"),
      // arrayBuffer (not text) so workerd does not warn about reading a form as text; Hono caches it, so
      // handlers can still call c.req.parseBody() afterwards.
      body:
        c.req.method === "GET" || c.req.method === "HEAD"
          ? ""
          : new TextDecoder().decode(await c.req.arrayBuffer()),
    });
    if (!ok) return reject("bad signature");
    await next();
  };
}
