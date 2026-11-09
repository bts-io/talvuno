import { env, SELF } from "cloudflare:test";
import { computeTwilioSignature } from "../../src/worker/lib/twilio/signature";

/** The auth token the integration tests run with (vitest.config.ts sets TWILIO_AUTH_TOKEN). */
export const TEST_AUTH_TOKEN = (env as Env).TWILIO_AUTH_TOKEN!;

/**
 * Sends a form POST to `path` the way Twilio would: signed with the test auth token over PUBLIC_URL plus
 * `path` (query included) and `params`. Pass `signature` to override it (null drops the header).
 */
export async function signedTwilioPost(
  path: string,
  params: Record<string, string>,
  opts: { signature?: string | null; authToken?: string } = {},
): Promise<Response> {
  const url = new URL(path, env.PUBLIC_URL).toString();
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    "user-agent": "TwilioProxy/1.1",
  });
  const signature =
    opts.signature === undefined
      ? await computeTwilioSignature(opts.authToken ?? TEST_AUTH_TOKEN, url, params)
      : opts.signature;
  if (signature !== null) headers.set("x-twilio-signature", signature);
  return SELF.fetch(url, { method: "POST", headers, body: new URLSearchParams(params).toString() });
}
