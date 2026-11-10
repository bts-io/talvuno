import { describe, expect, it } from "vitest";
import {
  csvCell,
  csvRow,
  isoInZone,
  listDates,
  localDate,
  resolveRange,
  StatsRangeError,
  startOfLocalDay,
} from "../../src/worker/lib/stats-rules";

describe("csvCell", () => {
  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("a\r\nb")).toBe('"a\r\nb"');
    expect(csvCell("plain")).toBe("plain");
  });
  it("prefixes formula starters with a single quote", () => {
    for (const s of ["=1+1", "-2", "@SUM(A1)", "+cmd|' /C calc'!A0"])
      expect(csvCell(s)).toContain(`'${s[0]}`);
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("\tx")).toBe("'\tx");
  });
  it("keeps a valid E.164 number and plain numbers as they are", () => {
    expect(csvCell("+14155550100")).toBe("+14155550100");
    expect(csvCell(12)).toBe("12");
    expect(csvCell(null)).toBe("");
    expect(csvCell(true)).toBe("true");
  });
  it("ends a row with CRLF", () => {
    expect(csvRow(["a", 1])).toBe("a,1\r\n");
  });
});

describe("time zone helpers", () => {
  it("formats ISO 8601 with the zone offset", () => {
    expect(isoInZone(Date.parse("2026-06-10T01:00:00Z"), "Australia/Sydney")).toBe(
      "2026-06-10T11:00:00+10:00",
    );
    expect(isoInZone(Date.parse("2026-06-10T12:00:00Z"), "America/New_York")).toBe(
      "2026-06-10T08:00:00-04:00",
    );
    expect(isoInZone(Date.parse("2026-06-10T12:00:00Z"), "Asia/Kolkata")).toBe("2026-06-10T17:30:00+05:30");
  });
  it("finds local dates and day starts", () => {
    expect(localDate(Date.parse("2026-06-09T14:30:00Z"), "Australia/Sydney")).toBe("2026-06-10");
    expect(startOfLocalDay("2026-06-10", "Australia/Sydney")).toBe(Date.parse("2026-06-09T14:00:00Z"));
    expect(startOfLocalDay("2026-03-08", "America/New_York")).toBe(Date.parse("2026-03-08T05:00:00Z"));
    expect(startOfLocalDay("2026-03-09", "America/New_York")).toBe(Date.parse("2026-03-09T04:00:00Z"));
  });
});

describe("resolveRange", () => {
  it("defaults to the last 30 local days", () => {
    const r = resolveRange({}, "UTC", 366, Date.parse("2026-06-10T12:00:00Z"));
    expect(r).toMatchObject({ from: "2026-05-12", to: "2026-06-10", days: 30 });
  });
  it("accepts 366 days and refuses 367", () => {
    expect(resolveRange({ from: "2025-06-10", to: "2026-06-10" }, "UTC", 366).days).toBe(366);
    expect(() => resolveRange({ from: "2025-06-09", to: "2026-06-10" }, "UTC", 366)).toThrow(StatsRangeError);
  });
  it("refuses reversed and unreal dates", () => {
    expect(() => resolveRange({ from: "2026-06-10", to: "2026-06-09" }, "UTC", 366)).toThrow(StatsRangeError);
    expect(() => resolveRange({ from: "2026-02-30", to: "2026-03-01" }, "UTC", 366)).toThrow(StatsRangeError);
  });
  it("falls back to UTC for an unknown zone", () => {
    expect(resolveRange({ from: "2026-06-10", to: "2026-06-10" }, "Nowhere/Land", 366).timeZone).toBe("UTC");
  });
  it("lists dates", () => {
    expect(listDates("2026-02-27", 3)).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
  });
});
