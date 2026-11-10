/**
 * Phone number handling shared by the Worker and the browser. Every number stored or compared is E.164
 * ("+14155550100"); anything typed by a person or sent by Twilio goes through `toE164` first.
 */
import { type CountryCode, isSupportedCountry, parsePhoneNumberFromString } from "libphonenumber-js";

export type { CountryCode };

const E164 = /^\+[1-9]\d{6,14}$/;

/** True when `value` is already a syntactically valid E.164 string (no parsing, no country rules). */
export const isE164 = (value: string): boolean => E164.test(value);

/** True when `code` is an ISO 3166-1 alpha-2 country libphonenumber knows. */
export const isCountryCode = (code: string): code is CountryCode => isSupportedCountry(code);

/**
 * Normalizes what a person typed (or a Twilio "From" value) to E.164. National formats need `defaultCountry`.
 * Returns null for anything that is not a valid, dialable number.
 */
export function toE164(input: string, defaultCountry?: CountryCode): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // "00" is the international prefix in most of the world; libphonenumber only treats it so with a country.
  const candidate = trimmed.startsWith("00") ? `+${trimmed.slice(2)}` : trimmed;
  const parsed = parsePhoneNumberFromString(candidate, defaultCountry);
  if (!parsed?.isValid()) return null;
  return parsed.number;
}

/** The ISO country of an E.164 number, or null when it cannot be told (shared country calling codes). */
export function countryOf(e164: string): CountryCode | null {
  return parsePhoneNumberFromString(e164)?.country ?? null;
}

/** The country calling code ("61") of an E.164 number, or null when it cannot be parsed. */
export function callingCodeOf(e164: string): string | null {
  return parsePhoneNumberFromString(e164)?.countryCallingCode ?? null;
}

/** Human formatting for display. Falls back to the raw value for anything unparsable. */
export function formatPhone(e164: string, style: "international" | "national" = "international"): string {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return e164;
  return style === "national" ? parsed.formatNational() : parsed.formatInternational();
}

/**
 * Whether `e164` may be dialed or texted under a country allowlist. An empty allowlist allows nothing, so a
 * fresh install cannot run up international charges before the owner chooses countries.
 */
export function isAllowedDestination(e164: string, allowlist: readonly string[]): boolean {
  const country = countryOf(e164);
  return country !== null && allowlist.includes(country);
}
