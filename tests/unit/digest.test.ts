import { describe, expect, it } from "vitest";
import { preferencesSchema } from "../../src/contracts";
import { digestBody, digestDue, localClock } from "../../src/worker/lib/digest-rules";

const at = (iso: string) => Date.parse(iso);

describe("localClock", () => {
  it("reads the date and minutes in the owner's zone", () => {
    // 2026-03-10 22:30 UTC is already the 11th at 09:30 in Sydney (UTC+11 in March).
    expect(localClock(at("2026-03-10T22:30:00Z"), "Australia/Sydney")).toEqual({
      date: "2026-03-11",
      minutes: 9 * 60 + 30,
    });
  });

  it("reads midnight as 00:00, not 24:00", () => {
    expect(localClock(at("2026-06-01T00:00:00Z"), "UTC")).toEqual({ date: "2026-06-01", minutes: 0 });
  });

  it("falls back to UTC for a zone it does not know", () => {
    expect(localClock(at("2026-06-01T10:15:00Z"), "Not/AZone")).toEqual({
      date: "2026-06-01",
      minutes: 10 * 60 + 15,
    });
  });
});

describe("digestDue", () => {
  const prefs = { digestTime: "08:00", timezone: "America/New_York", lastDigestDate: null };

  it("is not due one minute before the chosen time and due at it", () => {
    // 2026-06-10 is in daylight time: New York is UTC-4, so 08:00 local is 12:00 UTC.
    expect(digestDue(at("2026-06-10T11:59:00Z"), prefs).due).toBe(false);
    expect(digestDue(at("2026-06-10T12:00:00Z"), prefs)).toEqual({ due: true, date: "2026-06-10" });
  });

  it("follows the offset change on a daylight saving day", () => {
    // 2026-03-08 is the US spring-forward day. Before 07:00 UTC New York is UTC-5, after it UTC-4.
    // 08:00 local on the 8th is therefore 12:00 UTC (not 13:00).
    expect(digestDue(at("2026-03-08T11:59:00Z"), prefs).due).toBe(false);
    expect(digestDue(at("2026-03-08T12:00:00Z"), prefs).due).toBe(true);
    // The day before is still UTC-5, so 08:00 local is 13:00 UTC.
    expect(digestDue(at("2026-03-07T12:59:00Z"), prefs).due).toBe(false);
    expect(digestDue(at("2026-03-07T13:00:00Z"), prefs).due).toBe(true);
  });

  it("catches up when the chosen time falls in the skipped hour", () => {
    // 02:30 does not exist on 2026-03-08 in New York. The first run after the gap sends it.
    const skipped = { ...prefs, digestTime: "02:30" };
    expect(digestDue(at("2026-03-08T06:59:00Z"), skipped).due).toBe(false);
    expect(digestDue(at("2026-03-08T07:00:00Z"), skipped).due).toBe(true);
  });

  it("is due once per local date", () => {
    const sent = { ...prefs, lastDigestDate: "2026-06-10" };
    expect(digestDue(at("2026-06-10T15:00:00Z"), sent).due).toBe(false);
    expect(digestDue(at("2026-06-11T12:00:00Z"), sent).due).toBe(true);
  });

  it("uses the local date, not the UTC one", () => {
    // Sydney, 08:00. 2026-06-10 22:00 UTC is 08:00 on the 11th local (UTC+10 in June).
    const syd = { digestTime: "08:00", timezone: "Australia/Sydney", lastDigestDate: "2026-06-10" };
    expect(digestDue(at("2026-06-10T22:00:00Z"), syd)).toEqual({ due: true, date: "2026-06-11" });
  });
});

describe("digestBody", () => {
  it("is null when there is nothing to report", () => {
    expect(digestBody({ missedCalls: 0, voicemails: 0, unreadTexts: 0 })).toBeNull();
  });

  it("lists every count and uses singular for one", () => {
    expect(digestBody({ missedCalls: 3, voicemails: 1, unreadTexts: 5 })).toBe(
      "3 missed calls, 1 voicemail, 5 unread texts",
    );
    expect(digestBody({ missedCalls: 1, voicemails: 0, unreadTexts: 1 })).toBe(
      "1 missed call, 0 voicemails, 1 unread text",
    );
  });
});

describe("preferences contract", () => {
  const base = {
    defaultNumberId: null,
    countryAllowlist: [],
    locale: "en",
    theme: "system",
    smsPerHour: 30,
    callsPerHour: 20,
    digestEnabled: true,
    digestTime: "08:00",
    timezone: "Australia/Sydney",
  };

  it("accepts a valid digest setup", () => {
    expect(preferencesSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a bad time and an unknown time zone", () => {
    expect(preferencesSchema.safeParse({ ...base, digestTime: "24:00" }).success).toBe(false);
    expect(preferencesSchema.safeParse({ ...base, digestTime: "8:00" }).success).toBe(false);
    expect(preferencesSchema.safeParse({ ...base, timezone: "Mars/Olympus" }).success).toBe(false);
  });
});
