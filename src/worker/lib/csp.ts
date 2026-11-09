/**
 * Content-Security-Policy for server-rendered pages.
 *
 * Twilio Voice SDK 2.x hosts, from the SDK README section "Content Security Policy":
 * https://github.com/twilio/twilio-voice.js#content-security-policy
 * It lists the insights hosts (one global, one per home region), the signaling host (one per edge), and
 * https://media.twiliocdn.com and https://sdk.twilio.com (ringtones and sounds). Edge and region are
 * deployment choices, so the signaling and insights hosts are covered with one wildcard each
 * instead of a list that breaks when the edge changes.
 */
export const TWILIO_CONNECT_SRC = [
  "https://*.twilio.com",
  "wss://*.twilio.com",
  "https://media.twiliocdn.com",
] as const;
export const TWILIO_MEDIA_SRC = ["https://sdk.twilio.com", "https://media.twiliocdn.com"] as const;

export const CSP_HEADER = "content-security-policy";
export const CSP_REPORT_ONLY_HEADER = "content-security-policy-report-only";

/** 128 bits from the platform CSPRNG, base64. One per request, never reused. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * `style-src 'unsafe-inline'`: React sets `style` attributes on elements and the router can emit inline style
 * tags, and nonces do not cover style attributes. Scripts, the risky part, stay nonce-only.
 */
export function buildCsp(nonce: string, requestUrl: string): string {
  const url = new URL(requestUrl);
  // /api/live is a same-origin WebSocket. 'self' covers it in current browsers, the explicit origin covers older Safari.
  const ownWs = `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`;
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${ownWs} ${TWILIO_CONNECT_SRC.join(" ")}`,
    `media-src 'self' blob: mediastream: ${TWILIO_MEDIA_SRC.join(" ")}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/** Sets the policy on a response: enforcing by default, report-only when `CSP_REPORT_ONLY` is "true". */
export function applyCsp(
  headers: Headers,
  nonce: string,
  requestUrl: string,
  reportOnly: string | undefined,
) {
  headers.set(reportOnly === "true" ? CSP_REPORT_ONLY_HEADER : CSP_HEADER, buildCsp(nonce, requestUrl));
}
