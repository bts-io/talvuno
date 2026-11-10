/**
 * Weekly opening hours with an IANA time zone, and whether a moment falls inside them. Pure, shared by the
 * Worker (call routing) and the browser (the Settings summary).
 */
import { z } from "zod";

/** 0 is Sunday, as in Date.prototype.getDay. */
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

/** Whether Intl knows this IANA time zone. */
export function isTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + m;
};

export const openingSchema = z
  .object({
    day: z.number().int().min(0).max(6),
    open: z.string().regex(HHMM),
    close: z.string().regex(HHMM),
  })
  .refine((o) => minutes(o.close) > minutes(o.open), { message: "Closing time must be after opening time" });

export const businessHoursSchema = z.object({
  timeZone: z.string().refine(isTimeZone, { message: "Unknown time zone" }),
  /** Open periods. A day with no period is closed all day. */
  days: z.array(openingSchema).max(28),
});
export type BusinessHours = z.infer<typeof businessHoursSchema>;
export type Opening = z.infer<typeof openingSchema>;

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The weekday and minute of the day at `at` in `timeZone`. */
export function localTime(at: Date, timeZone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    day: WEEKDAY_INDEX[get("weekday")] ?? 0,
    minute: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/**
 * Whether `at` falls inside `hours`. No hours set means always open. Hours that cannot be read (a time zone
 * the runtime no longer knows) also count as open, so a bad setting never silences every call.
 */
export function isOpenAt(hours: BusinessHours | null | undefined, at: Date): boolean {
  if (!hours) return true;
  let now: { day: number; minute: number };
  try {
    now = localTime(at, hours.timeZone);
  } catch {
    return true;
  }
  return hours.days.some(
    (o) => o.day === now.day && now.minute >= minutes(o.open) && now.minute < minutes(o.close),
  );
}
