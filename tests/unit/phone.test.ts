import { describe, expect, it } from "vitest";
import { countryOf, formatPhone, isAllowedDestination, isE164, toE164 } from "../../src/lib/phone";

describe("toE164", () => {
  it("keeps valid E.164 input", () => {
    expect(toE164("+14155552671")).toBe("+14155552671");
  });

  it("normalizes spaces, dashes and brackets", () => {
    expect(toE164("+1 (415) 555-2671")).toBe("+14155552671");
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("reads the 00 international prefix", () => {
    expect(toE164("0044 20 7946 0958")).toBe("+442079460958");
  });

  it("needs a country for national formats", () => {
    expect(toE164("(415) 555-2671")).toBeNull();
    expect(toE164("(415) 555-2671", "US")).toBe("+14155552671");
    expect(toE164("0412 345 678", "AU")).toBe("+61412345678");
  });

  it("rejects invalid and empty input", () => {
    expect(toE164("")).toBeNull();
    expect(toE164("   ")).toBeNull();
    expect(toE164("hello")).toBeNull();
    expect(toE164("+1 555")).toBeNull();
    expect(toE164("+999123456789")).toBeNull();
  });
});

describe("helpers", () => {
  it("isE164 checks shape only", () => {
    expect(isE164("+14155552671")).toBe(true);
    expect(isE164("14155552671")).toBe(false);
    expect(isE164("+0123")).toBe(false);
  });

  it("countryOf finds the country", () => {
    expect(countryOf("+14155552671")).toBe("US");
    expect(countryOf("+61412345678")).toBe("AU");
  });

  it("formatPhone formats for display and falls back to the raw value", () => {
    expect(formatPhone("+14155552671")).toBe("+1 415 555 2671");
    expect(formatPhone("+14155552671", "national")).toBe("(415) 555-2671");
    expect(formatPhone("garbage")).toBe("garbage");
  });

  it("isAllowedDestination denies everything with an empty allowlist", () => {
    expect(isAllowedDestination("+14155552671", [])).toBe(false);
    expect(isAllowedDestination("+14155552671", ["US"])).toBe(true);
    expect(isAllowedDestination("+61412345678", ["US"])).toBe(false);
  });
});
