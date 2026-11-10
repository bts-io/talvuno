/** The pure rules of the morning digest: local time, once a day, and the wording. No Worker types here. */

export type DigestCounts = { missedCalls: number; voicemails: number; unreadTexts: number };

/** The local calendar date (YYYY-MM-DD) and minutes since local midnight at `now` in `timeZone`. */
export function localClock(now: number, timeZone: string): { date: string; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = zoneFormat(timeZone).formatToParts(now);
  } catch {
    parts = zoneFormat("UTC").formatToParts(now);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  // Some engines print midnight as hour 24.
  const hour = Number(get("hour")) % 24;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: hour * 60 + Number(get("minute")) };
}

const zoneFormat = (timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

/** True once the owner's local time has reached `digestTime` and no digest went for that local date. */
export function digestDue(
  now: number,
  p: { digestTime: string; timezone: string; lastDigestDate: string | null },
): { due: boolean; date: string } {
  const { date, minutes } = localClock(now, p.timezone);
  const [h, m] = p.digestTime.split(":").map(Number);
  return { due: minutes >= (h ?? 0) * 60 + (m ?? 0) && p.lastDigestDate !== date, date };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 missed calls, 1 voicemail, 5 unread texts". Null when there is nothing to report. */
export function digestBody(c: DigestCounts): string | null {
  if (!c.missedCalls && !c.voicemails && !c.unreadTexts) return null;
  return [
    plural(c.missedCalls, "missed call", "missed calls"),
    plural(c.voicemails, "voicemail", "voicemails"),
    plural(c.unreadTexts, "unread text", "unread texts"),
  ].join(", ");
}
