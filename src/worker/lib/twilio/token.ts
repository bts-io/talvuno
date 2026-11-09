/**
 * Twilio Voice access tokens, signed in the Worker with Web Crypto. The layout follows the `twilio` npm
 * package (lib/jwt/AccessToken.js with a VoiceGrant): an HS256 JWT signed with the API key secret, header
 * `cty: "twilio-fpa;v=1"`, issuer the API key SID, subject the account SID, `jti` "{keySid}-{iat}", and the
 * grants under `grants` (identity plus voice.incoming / voice.outgoing).
 */

/** Twilio rejects access tokens that live longer than 24 hours. */
export const MAX_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export class VoiceTokenConfigError extends Error {
  constructor(missing: string[]) {
    super(`Voice tokens need ${missing.join(", ")}`);
    this.name = "VoiceTokenConfigError";
  }
}

export type VoiceTokenPayload = {
  jti: string;
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  grants: {
    identity: string;
    voice: { incoming: { allow: true }; outgoing: { application_sid: string } };
  };
};

const encoder = new TextEncoder();

function base64url(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Signs `payload` as an HS256 JWT with the given header fields. */
export async function signJwt(
  header: Record<string, string>,
  payload: unknown,
  secret: string,
): Promise<string> {
  const input = `${base64url(JSON.stringify({ alg: "HS256", ...header }))}.${base64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(input)));
  return `${input}.${base64url(sig)}`;
}

/**
 * An access token for the browser Voice SDK: `identity` may receive calls (incoming.allow) and place calls
 * through the TwiML App (outgoing.application_sid = TWILIO_TWIML_APP_SID). `ttlSeconds` is capped at 24 hours.
 */
export async function createVoiceAccessToken(
  env: Env,
  identity: string,
  ttlSeconds: number,
): Promise<string> {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const keySid = env.TWILIO_API_KEY_SID;
  const secret = env.TWILIO_API_KEY_SECRET;
  const appSid = env.TWILIO_TWIML_APP_SID;
  if (!accountSid || !keySid || !secret || !appSid) {
    const missing = Object.entries({
      TWILIO_ACCOUNT_SID: accountSid,
      TWILIO_API_KEY_SID: keySid,
      TWILIO_API_KEY_SECRET: secret,
      TWILIO_TWIML_APP_SID: appSid,
    })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    throw new VoiceTokenConfigError(missing);
  }
  if (!identity) throw new Error("identity is required");
  const ttl = Math.max(1, Math.min(Math.floor(ttlSeconds), MAX_TOKEN_TTL_SECONDS));
  const now = Math.floor(Date.now() / 1000);
  const payload: VoiceTokenPayload = {
    jti: `${keySid}-${now}`,
    iss: keySid,
    sub: accountSid,
    iat: now,
    exp: now + ttl,
    grants: {
      identity,
      voice: { incoming: { allow: true }, outgoing: { application_sid: appSid } },
    },
  };
  return signJwt({ typ: "JWT", cty: "twilio-fpa;v=1" }, payload, secret);
}
