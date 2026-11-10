import { describe, expect, it } from "vitest";
import { SCHEDULE_MAX_LEAD_MS, SCHEDULE_MIN_LEAD_MS, sendAtProblem } from "../../src/contracts/scheduled";
import { epochToZoned, zonedToEpoch } from "../../src/lib/schedule-time";

describe("schedule time zones", () => {
  it("reads a wall-clock time in the owner's zone", () => {
    // Sydney is UTC+11 in January (daylight saving) and UTC+10 in July.
    expect(zonedToEpoch("2027-01-15T09:00", "Australia/Sydney")).toBe(Date.UTC(2027, 0, 14, 22, 0));
    expect(zonedToEpoch("2027-07-15T09:00", "Australia/Sydney")).toBe(Date.UTC(2027, 6, 14, 23, 0));
    expect(zonedToEpoch("2027-01-15T09:00", "America/New_York")).toBe(Date.UTC(2027, 0, 15, 14, 0));
    expect(zonedToEpoch("2027-01-15T09:00", "UTC")).toBe(Date.UTC(2027, 0, 15, 9, 0));
  });

  it("round trips through the zone", () => {
    const ms = Date.UTC(2027, 2, 3, 4, 5);
    for (const tz of ["Australia/Sydney", "Asia/Tokyo", "America/Los_Angeles", "UTC"])
      expect(zonedToEpoch(epochToZoned(ms, tz), tz)).toBe(ms);
  });

  it("settles the offset across a daylight saving change", () => {
    // 2027-04-04 03:00 Sydney is just after the clocks go back, so it is still UTC+10 afterwards.
    expect(zonedToEpoch("2027-04-04T09:00", "Australia/Sydney")).toBe(Date.UTC(2027, 3, 3, 23, 0));
    expect(zonedToEpoch("2027-03-14T09:00", "America/New_York")).toBe(Date.UTC(2027, 2, 14, 13, 0));
  });

  it("rejects malformed values and unknown zones", () => {
    expect(zonedToEpoch("tomorrow", "UTC")).toBeNull();
    expect(zonedToEpoch("2027-01-15T09:00", "Not/AZone")).toBeNull();
  });

  it("applies the lead time window", () => {
    const now = 1_000_000_000_000;
    expect(sendAtProblem(now + SCHEDULE_MIN_LEAD_MS - 1, now)).toBe("too_soon");
    expect(sendAtProblem(now + SCHEDULE_MIN_LEAD_MS, now)).toBeNull();
    expect(sendAtProblem(now + SCHEDULE_MAX_LEAD_MS, now)).toBeNull();
    expect(sendAtProblem(now + SCHEDULE_MAX_LEAD_MS + 1, now)).toBe("too_far");
  });
});
