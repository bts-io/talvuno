/** Small pure helpers for the Stats page. */

/** Today's date (YYYY-MM-DD) in an IANA zone. */
export function todayIn(timeZone: string, now = Date.now()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

/** A date shifted by whole days. */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Days from `from` to `to`, both included. */
export function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** "1:30" for 90 seconds, "1:02:03" past an hour. */
export function formatSeconds(total: number): string {
  const s = Math.round(total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** A rate between 0 and 1 as a percentage, one decimal only when it helps ("33.3%", "50%"). */
export function formatPercent(rate: number): string {
  const p = Math.round(rate * 1000) / 10;
  return `${Number.isInteger(p) ? p : p.toFixed(1)}%`;
}
