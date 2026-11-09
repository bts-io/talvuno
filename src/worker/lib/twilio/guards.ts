/**
 * Checks that run before any outbound SMS or call reaches Twilio. Order matters: the destination checks come
 * first, so a refused number never spends one of the owner's hourly sends.
 */
import type { Context } from "hono";
// The full metadata knows number types (premium rate). About 20 KB gzipped, Worker only: the browser keeps
// the small metadata through src/lib/phone.ts.
import { parsePhoneNumberFromString as parseWithTypes } from "libphonenumber-js/max";
import { isAllowedDestination, isE164, toE164 } from "../../../lib/phone";
import type { AppEnv } from "../../types";
import { ApiError } from "../errors";
import { consume } from "../hub";
import { getPreferences } from "../preferences";

export type ContactKind = "sms" | "call";

/** A limit from the database as a safe count: anything not a finite positive number becomes 0. */
const safeLimit = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * Throws unless `ownerId` may text or call `e164` right now:
 * - 400 `invalid_number` unless it is a valid full E.164 number. This is for outbound only: short codes,
 *   alphanumeric sender IDs and withheld callers ("anonymous", "restricted") that arrive inbound are refused.
 * - 403 `premium_rate` for premium-rate numbers.
 * - 403 `country_not_allowed` when its country is not in the owner's allowlist (empty allows nothing).
 * - 429 `rate_limited` when the hourly limit for `kind` is used up. Otherwise one unit is taken.
 */
export async function assertCanContact(
  c: Pick<Context<AppEnv>, "env" | "get">,
  ownerId: string,
  e164: string,
  kind: ContactKind,
): Promise<void> {
  if (typeof e164 !== "string" || !isE164(e164) || toE164(e164) !== e164)
    throw new ApiError(400, "invalid_number", "Not a valid phone number");
  if (parseWithTypes(e164)?.getType() === "PREMIUM_RATE")
    throw new ApiError(403, "premium_rate", "Premium-rate numbers are blocked");
  const limits = await getPreferences(c.get("db"), ownerId);
  if (!isAllowedDestination(e164, Array.isArray(limits.countryAllowlist) ? limits.countryAllowlist : []))
    throw new ApiError(403, "country_not_allowed", "That country is not in your allowed list");
  const limit = safeLimit(kind === "sms" ? limits.smsPerHour : limits.callsPerHour);
  if (limit === 0)
    throw new ApiError(
      429,
      "rate_limited",
      kind === "sms" ? "Hourly message limit reached" : "Hourly call limit reached",
    );
  const result = await consume(c.env, ownerId, kind, limit, 3600);
  if (!result.allowed)
    throw new ApiError(
      429,
      "rate_limited",
      kind === "sms" ? "Hourly message limit reached" : "Hourly call limit reached",
    );
}
