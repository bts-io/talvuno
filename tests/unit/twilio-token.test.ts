import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVoiceAccessToken,
  MAX_TOKEN_TTL_SECONDS,
  VoiceTokenConfigError,
} from "../../src/worker/lib/twilio/token";

const ENV = {
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
  TWILIO_API_KEY_SID: "SK00000000000000000000000000000000",
  TWILIO_API_KEY_SECRET: "test-api-key-secret",
  TWILIO_TWIML_APP_SID: "AP00000000000000000000000000000000",
} as unknown as Env;

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

afterEach(() => vi.useRealTimers());

describe("createVoiceAccessToken", () => {
  it("builds the header and claims the twilio package builds for a VoiceGrant", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-09T12:00:00Z") });
    const now = Math.floor(Date.now() / 1000);
    const token = await createVoiceAccessToken(ENV, "owner-1", 3600);
    const [h, p] = token.split(".");
    expect(decode(h!)).toEqual({ alg: "HS256", typ: "JWT", cty: "twilio-fpa;v=1" });
    expect(decode(p!)).toEqual({
      jti: `SK00000000000000000000000000000000-${now}`,
      iss: "SK00000000000000000000000000000000",
      sub: "AC00000000000000000000000000000000",
      iat: now,
      exp: now + 3600,
      grants: {
        identity: "owner-1",
        voice: {
          incoming: { allow: true },
          outgoing: { application_sid: "AP00000000000000000000000000000000" },
        },
      },
    });
  });

  it("is signed with HS256 and the API key secret", async () => {
    const token = await createVoiceAccessToken(ENV, "owner-1", 600);
    const [h, p, s] = token.split(".");
    const expected = createHmac("sha256", "test-api-key-secret").update(`${h}.${p}`).digest("base64url");
    expect(s).toBe(expected);
    const wrong = createHmac("sha256", "other").update(`${h}.${p}`).digest("base64url");
    expect(s).not.toBe(wrong);
  });

  it("caps the lifetime at 24 hours", async () => {
    const token = await createVoiceAccessToken(ENV, "owner-1", 10 * MAX_TOKEN_TTL_SECONDS);
    const payload = decode(token.split(".")[1]!);
    expect(payload.exp - payload.iat).toBe(MAX_TOKEN_TTL_SECONDS);
  });

  it("refuses without the TwiML App or API key", async () => {
    await expect(
      createVoiceAccessToken({ ...ENV, TWILIO_TWIML_APP_SID: undefined }, "o", 60),
    ).rejects.toThrow(VoiceTokenConfigError);
    await expect(
      createVoiceAccessToken({ ...ENV, TWILIO_API_KEY_SECRET: undefined }, "o", 60),
    ).rejects.toThrow(/TWILIO_API_KEY_SECRET/);
  });
});
