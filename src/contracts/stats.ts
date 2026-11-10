/** Contracts for the activity stats and CSV export APIs. */
import { z } from "zod";

/** The longest range the stats and exports accept, in local calendar days. */
export const STATS_MAX_DAYS = 366;

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date as YYYY-MM-DD");

/** Local calendar dates, both ends included, in the owner's time zone. Both default to the last 30 days. */
export const statsQuerySchema = z.object({
  from: localDate.optional(),
  to: localDate.optional(),
  numberId: z.string().min(1).max(64).optional(),
});
export type StatsQuery = z.infer<typeof statsQuerySchema>;

export const statsDaySchema = z.object({
  date: z.string(),
  callsInbound: z.number(),
  callsOutbound: z.number(),
  missed: z.number(),
  textsSent: z.number(),
  textsReceived: z.number(),
  voicemails: z.number(),
});
export type StatsDay = z.infer<typeof statsDaySchema>;

export const statsSchema = z.object({
  range: z.object({ from: z.string(), to: z.string(), timeZone: z.string(), days: z.number() }),
  totals: z.object({
    calls: z.number(),
    callsInbound: z.number(),
    callsOutbound: z.number(),
    missed: z.number(),
    /** Inbound calls that count toward the missed rate: all of them except blocked ones. */
    callsInboundRated: z.number(),
    /** Missed inbound calls over `callsInboundRated`. Null when that is zero. */
    missedRate: z.number().nullable(),
    answered: z.number(),
    /** Seconds. Null when no call was answered. */
    avgAnsweredSeconds: z.number().nullable(),
    textsSent: z.number(),
    textsReceived: z.number(),
    voicemails: z.number(),
  }),
  days: z.array(statsDaySchema),
  topContacts: z.array(
    z.object({
      party: z.string(),
      name: z.string().nullable(),
      calls: z.number(),
      texts: z.number(),
      voicemails: z.number(),
      total: z.number(),
    }),
  ),
});
export type Stats = z.infer<typeof statsSchema>;
