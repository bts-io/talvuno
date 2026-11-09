import { ApiError } from "./errors";
import { TwilioApiError, TwilioNotConfiguredError, type TwilioRest, twilioRest } from "./twilio/rest";

/** The REST client, or a 503 `not_configured` when this deployment has no Twilio account or API key. */
export function restOrThrow(env: Env): TwilioRest {
  try {
    return twilioRest(env);
  } catch (err) {
    if (err instanceof TwilioNotConfiguredError) throw new ApiError(503, "not_configured", err.message);
    throw err;
  }
}

/** Runs a Twilio call and turns a Twilio failure into a 502 `twilio_error` with Twilio's own message. */
export async function viaTwilio<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TwilioApiError)
      throw new ApiError(
        502,
        "twilio_error",
        `Twilio: ${err.message}${err.code ? ` (code ${err.code})` : ""}`,
      );
    throw err;
  }
}

/** PUBLIC_URL without a trailing slash, or a 503 when it is not set. */
export function publicUrl(env: Env): string {
  const url = (env.PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (!url) throw new ApiError(503, "not_configured", "PUBLIC_URL is not set");
  return url;
}
