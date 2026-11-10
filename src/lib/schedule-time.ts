/** Time zone maths for the schedule picker: a wall-clock time in an IANA zone to and from epoch milliseconds. */

const parts = (ms: number, timeZone: string) => {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(ms);
  const get = (type: string) => Number(f.find((p) => p.type === type)?.value ?? 0);
  return {
    y: get("year"),
    mo: get("month"),
    d: get("day"),
    h: get("hour") % 24,
    mi: get("minute"),
    s: get("second"),
  };
};

/** Milliseconds the zone is ahead of UTC at instant `ms`. */
function offsetAt(ms: number, timeZone: string): number {
  const p = parts(ms, timeZone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** "YYYY-MM-DDTHH:mm" (a datetime-local value) read as wall-clock time in `timeZone`. Null when malformed. */
export function zonedToEpoch(local: string, timeZone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  try {
    // Two passes settle the offset when the first guess lands across a daylight saving change.
    let guess = naive - offsetAt(naive, timeZone);
    guess = naive - offsetAt(guess, timeZone);
    return guess;
  } catch {
    return null;
  }
}

/** The datetime-local value for instant `ms` as seen in `timeZone`. */
export function epochToZoned(ms: number, timeZone: string): string {
  const p = parts(ms, timeZone);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${two(p.mo)}-${two(p.d)}T${two(p.h)}:${two(p.mi)}`;
}
