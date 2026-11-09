import { Hono } from "hono";
import type { ConfigStatus, TwilioTestResult } from "../../contracts/numbers";
import { TwilioApiError, TwilioNotConfiguredError, twilioRest } from "../lib/twilio/rest";
import type { AppEnv } from "../types";

/** Setup checks for the Settings screen. Mounted at /api/status. Answers never contain a setting's value. */
export const status = new Hono<AppEnv>();

const has = (v: unknown) => typeof v === "string" && v.trim() !== "";

/** Which settings are present. Booleans only. */
export function configStatus(env: Env): ConfigStatus {
  // The OIDC settings belong to the sign-in feature; read them by name so this file does not depend on it.
  const e = env as unknown as Record<string, unknown>;
  return {
    twilioAccountSid: has(env.TWILIO_ACCOUNT_SID),
    twilioApiKey: has(env.TWILIO_API_KEY_SID) && has(env.TWILIO_API_KEY_SECRET),
    twilioAuthToken: has(env.TWILIO_AUTH_TOKEN),
    twilioTwimlApp: has(env.TWILIO_TWIML_APP_SID),
    publicUrl: has(env.PUBLIC_URL),
    vapid: has(env.VAPID_PUBLIC_KEY) && has(env.VAPID_PRIVATE_KEY),
    oidc: has(e.OIDC_DISCOVERY_URL) && has(e.OIDC_CLIENT_ID) && has(e.OIDC_CLIENT_SECRET),
    setupToken: has(env.SETUP_TOKEN),
  };
}

status.get("/config", (c) => {
  c.header("cache-control", "no-store");
  return c.json(configStatus(c.env));
});

/**
 * One cheap authenticated read of the balance. Standard API keys cannot read the account resource itself,
 * but Balance.json proves the key and the account SID. Always answers 200 with `ok` true or false.
 */
status.post("/twilio-test", async (c) => {
  c.header("cache-control", "no-store");
  try {
    const rest = twilioRest(c.env);
    const balance = await rest.get<{ currency?: string }>("/Balance.json");
    return c.json({ ok: true, currency: (balance.currency ?? "").toUpperCase() } satisfies TwilioTestResult);
  } catch (err) {
    if (err instanceof TwilioNotConfiguredError)
      return c.json({ ok: false, error: err.message } satisfies TwilioTestResult);
    if (err instanceof TwilioApiError)
      return c.json({ ok: false, error: err.message, code: err.code } satisfies TwilioTestResult);
    throw err;
  }
});
