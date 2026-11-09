/**
 * Owner-facing voice API, mounted at /api/voice (session and Origin checks apply).
 *
 *   POST /token       a Voice access token for this browser, valid one hour
 *   GET  /caller-ids  the numbers a call may go out from, default first
 *   GET  /ice-servers Twilio STUN and TURN servers for the browser's WebRTC connection
 */
import { Hono } from "hono";
import { ApiError } from "../lib/errors";
import { getIceServers } from "../lib/twilio/ice";
import { createVoiceAccessToken, VoiceTokenConfigError } from "../lib/twilio/token";
import { voiceIdentity } from "../lib/voice/identity";
import { voiceNumbers } from "../lib/voice/numbers";
import type { AppEnv } from "../types";

export const VOICE_TOKEN_TTL_SECONDS = 60 * 60;

export const voice = new Hono<AppEnv>();

voice.post("/token", async (c) => {
  // The identity comes from the session, never from the request body.
  const identity = voiceIdentity(c.get("user")!.id);
  try {
    const token = await createVoiceAccessToken(c.env, identity, VOICE_TOKEN_TTL_SECONDS);
    c.header("cache-control", "no-store");
    return c.json({ token, identity, ttl: VOICE_TOKEN_TTL_SECONDS });
  } catch (err) {
    if (err instanceof VoiceTokenConfigError)
      throw new ApiError(503, "not_configured", "Calling is not set up on this server yet");
    throw err;
  }
});

voice.get("/caller-ids", async (c) => {
  const numbers = await voiceNumbers(c.get("db"), c.get("user")!.id);
  return c.json({
    numbers: numbers.map((n, i) => ({
      id: n.id,
      e164: n.e164,
      friendlyName: n.friendlyName,
      isDefault: i === 0,
    })),
  });
});

voice.get("/ice-servers", async (c) => {
  // TURN credentials: never stored by the browser cache or a proxy.
  c.header("cache-control", "no-store");
  return c.json(await getIceServers(c.env));
});
