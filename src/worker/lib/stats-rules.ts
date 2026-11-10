/** Pure helpers for stats and exports: local days in an IANA zone, ISO times with offset, CSV cells. */
import { isTimeZone } from "../../lib/business-hours";
import { isE164 } from "../../lib/phone";

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function zoneFormat(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** A zone name Intl knows, else UTC. */
export const safeZone = (tz: string) => (isTimeZone(tz) ? tz : "UTC");

/** Offset of `timeZone` from UTC at `ms`, in minutes. */
export function offsetMinutes(ms: number, timeZone: string): number {
  const parts = zoneFormat(timeZone).formatToParts(ms);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** The local calendar date (YYYY-MM-DD) of `ms` in `timeZone`. */
export function localDate(ms: number, timeZone: string): string {
  return new Date(ms + offsetMinutes(ms, timeZone) * 60_000).toISOString().slice(0, 10);
}

/** "2026-06-10T08:00:00-04:00": ISO 8601 with the zone's offset. */
export function isoInZone(ms: number, timeZone: string): string {
  const off = offsetMinutes(ms, timeZone);
  const local = new Date(ms + off * 60_000).toISOString().slice(0, 19);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${local}${sign}${hh}:${mm}`;
}

/** The instant a local calendar date starts in `timeZone`. */
export function startOfLocalDay(date: string, timeZone: string): number {
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  let guess = utcMidnight - offsetMinutes(utcMidnight, timeZone) * 60_000;
  // A second pass settles dates where the offset changes between the first guess and midnight.
  guess = utcMidnight - offsetMinutes(guess, timeZone) * 60_000;
  return guess;
}

const isRealDate = (d: string) => {
  const ms = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === d;
};

export const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export type ResolvedRange = {
  from: string;
  to: string;
  days: number;
  /** Start of the first local day, inclusive. */
  startMs: number;
  /** Start of the day after the last local day, exclusive. */
  endMs: number;
  timeZone: string;
};

export class StatsRangeError extends Error {
  constructor(
    public code: "invalid_range" | "range_too_long",
    message: string,
  ) {
    super(message);
  }
}

/** Resolves `from` and `to` (local dates, inclusive) in the owner's zone. Defaults to the last 30 days. */
export function resolveRange(
  q: { from?: string; to?: string },
  timeZone: string,
  maxDays: number,
  now = Date.now(),
): ResolvedRange {
  const tz = safeZone(timeZone);
  const to = q.to ?? localDate(now, tz);
  const from = q.from ?? addDays(to, -29);
  if (!isRealDate(from) || !isRealDate(to)) throw new StatsRangeError("invalid_range", "Not a real date");
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (days < 1) throw new StatsRangeError("invalid_range", "The start date is after the end date");
  if (days > maxDays) throw new StatsRangeError("range_too_long", `The range is limited to ${maxDays} days`);
  return {
    from,
    to,
    days,
    startMs: startOfLocalDay(from, tz),
    endMs: startOfLocalDay(addDays(to, 1), tz),
    timeZone: tz,
  };
}

/** Every local date from `from`, `days` of them. */
export const listDates = (from: string, days: number): string[] =>
  Array.from({ length: days }, (_, i) => addDays(from, i));

/**
 * One CSV cell. Quotes when needed and defuses spreadsheet formulas: a text cell starting with = + - @ (or a
 * tab or carriage return) gets a leading single quote. A strictly valid E.164 number is kept as is, because
 * it cannot hold a formula and the quote would break sorting and lookups.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s) && !isE164(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export const csvRow = (cells: (string | number | boolean | null | undefined)[]) =>
  `${cells.map(csvCell).join(",")}\r\n`;
