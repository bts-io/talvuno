/**
 * Activity stats and CSV export, read only and owner scoped like every /api route. Days are the owner's local
 * days (the digest time zone preference).
 *
 *   GET /api/stats?from&to&numberId                 stats as JSON
 *   GET /api/export/calls.csv?from&to&numberId      calls, one row each, streamed
 *   GET /api/export/messages.csv?from&to&numberId   texts, one row each, streamed
 */
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { isMissedCall } from "../../contracts/contacts";
import { STATS_MAX_DAYS, statsQuerySchema } from "../../contracts/stats";
import { type Db, schema } from "../db";
import { ApiError } from "../lib/errors";
import { getPreferences } from "../lib/preferences";
import { computeStats } from "../lib/stats";
import { csvRow, isoInZone, type ResolvedRange, resolveRange, StatsRangeError } from "../lib/stats-rules";
import { validationHook } from "../lib/validation";
import type { AppEnv } from "../types";

const { calls, messages, conversations, phoneNumbers } = schema;

const PAGE = 500;

async function rangeFor(
  c: { get: (k: "db") => Db; req: { valid: (t: "query") => unknown } },
  ownerId: string,
) {
  const q = c.req.valid("query") as { from?: string; to?: string; numberId?: string };
  const prefs = await getPreferences(c.get("db"), ownerId);
  try {
    return { q, range: resolveRange(q, prefs.timezone, STATS_MAX_DAYS) };
  } catch (err) {
    if (err instanceof StatsRangeError) throw new ApiError(400, err.code, err.message);
    throw err;
  }
}

export const statsRouter = new Hono<AppEnv>();

statsRouter.get("/", zValidator("query", statsQuerySchema, validationHook), async (c) => {
  const ownerId = c.get("user")!.id;
  const { q, range } = await rangeFor(c, ownerId);
  c.header("cache-control", "no-store");
  return c.json(await computeStats(c.get("db"), ownerId, range, q.numberId));
});

export const exportRouter = new Hono<AppEnv>();

const attachment = (kind: string, range: ResolvedRange) => ({
  "content-type": "text/csv; charset=utf-8",
  "content-disposition": `attachment; filename="talvuno-${kind}-${range.from}_${range.to}.csv"`,
  "cache-control": "no-store",
});

/** Streams `header` then each page of rows. `page(cursor)` returns the next rows, empty when done. */
function csvStream<T>(
  header: string[],
  page: (cursor: T | null) => Promise<{ lines: string[]; next: T | null }>,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let cursor: T | null = null;
  let started = false;
  let done = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(enc.encode(csvRow(header)));
        return;
      }
      if (done) return controller.close();
      const { lines, next } = await page(cursor);
      cursor = next;
      if (lines.length) controller.enqueue(enc.encode(lines.join("")));
      if (!next) done = true;
    },
  });
}

async function ownNumbers(db: Db, ownerId: string) {
  const rows = await db
    .select({ id: phoneNumbers.id, e164: phoneNumbers.e164 })
    .from(phoneNumbers)
    .where(eq(phoneNumbers.ownerId, ownerId));
  return new Map(rows.map((r) => [r.id, r.e164]));
}

exportRouter.get("/calls.csv", zValidator("query", statsQuerySchema, validationHook), async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const { q, range } = await rangeFor(c, ownerId);
  const numbers = await ownNumbers(db, ownerId);
  const at = sql<number>`coalesce(${calls.startedAt}, ${calls.createdAt})`;
  const inRange = sql`((${calls.startedAt} >= ${range.startMs} and ${calls.startedAt} < ${range.endMs}) or (${calls.startedAt} is null and ${calls.createdAt} >= ${range.startMs} and ${calls.createdAt} < ${range.endMs}))`;

  const body = csvStream<[number, string]>(
    ["time", "direction", "number", "party", "status", "outcome", "missed", "duration_seconds"],
    async (cursor) => {
      const conds = [eq(calls.ownerId, ownerId), inRange];
      if (q.numberId) conds.push(eq(calls.numberId, q.numberId));
      if (cursor)
        conds.push(sql`(${at} > ${cursor[0]} or (${at} = ${cursor[0]} and ${calls.id} > ${cursor[1]}))`);
      const rows = await db
        .select({ call: calls, at })
        .from(calls)
        .where(and(...conds))
        .orderBy(asc(at), asc(calls.id))
        .limit(PAGE);
      const last = rows.at(-1);
      return {
        lines: rows.map(({ call, at: t }) =>
          csvRow([
            isoInZone(Number(t), range.timeZone),
            call.direction,
            call.numberId ? (numbers.get(call.numberId) ?? "") : "",
            call.party,
            call.status,
            call.outcome,
            isMissedCall(call),
            call.duration,
          ]),
        ),
        next: rows.length === PAGE && last ? [Number(last.at), last.call.id] : null,
      };
    },
  );
  return new Response(body, { headers: attachment("calls", range) });
});

exportRouter.get("/messages.csv", zValidator("query", statsQuerySchema, validationHook), async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const { q, range } = await rangeFor(c, ownerId);
  const numbers = await ownNumbers(db, ownerId);

  const body = csvStream<[number, string]>(
    ["time", "direction", "number", "party", "status", "body"],
    async (cursor) => {
      const conds = [
        eq(messages.ownerId, ownerId),
        sql`${messages.createdAt} >= ${range.startMs} and ${messages.createdAt} < ${range.endMs}`,
      ];
      if (q.numberId) conds.push(eq(conversations.numberId, q.numberId));
      if (cursor)
        conds.push(
          sql`(${messages.createdAt} > ${cursor[0]} or (${messages.createdAt} = ${cursor[0]} and ${messages.id} > ${cursor[1]}))`,
        );
      const rows = await db
        .select({ m: messages, numberId: conversations.numberId })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(...conds))
        .orderBy(asc(messages.createdAt), asc(messages.id))
        .limit(PAGE);
      const last = rows.at(-1);
      return {
        lines: rows.map(({ m, numberId }) =>
          csvRow([
            isoInZone(m.createdAt.getTime(), range.timeZone),
            m.direction,
            numbers.get(numberId) ?? "",
            m.direction === "inbound" ? m.from : m.to,
            m.status,
            m.body,
          ]),
        ),
        next: rows.length === PAGE && last ? [last.m.createdAt.getTime(), last.m.id] : null,
      };
    },
  );
  return new Response(body, { headers: attachment("messages", range) });
});
