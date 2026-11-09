import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  type CallEntry,
  type CallList,
  callListQuerySchema,
  isMissedCall,
  MISSED_STATUSES,
} from "../../contracts/contacts";
import { schema } from "../db";
import { decodeCursor, encodeCursor } from "../lib/contacts";
import { validationHook } from "../lib/validation";
import type { AppEnv } from "../types";

const { calls, contacts, contactNumbers } = schema;

/**
 * Call history, read only. Rows are written by the Twilio webhooks (and never by the client), so there is no
 * POST here. Mounted at /api/calls.
 */
export const callsRouter = new Hono<AppEnv>();

/** When the call happened: its start, else the row's creation (a call can be logged before it starts). */
const happenedAt = sql<number>`coalesce(${calls.startedAt}, ${calls.createdAt})`;

callsRouter.get("/", zValidator("query", callListQuerySchema, validationHook), async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const { filter, cursor, limit } = c.req.valid("query");

  const conds = [eq(calls.ownerId, ownerId)];
  if (filter === "missed") {
    // The SQL form of isMissedCall.
    conds.push(
      eq(calls.direction, "inbound"),
      inArray(calls.status, [...MISSED_STATUSES]),
      isNull(calls.answeredAt),
    );
  }
  if (cursor) {
    const [at, id] = decodeCursor(cursor, ["number", "string"]) as [number, string];
    conds.push(or(lt(happenedAt, at), and(eq(happenedAt, at), lt(calls.id, id))) as (typeof conds)[number]);
  }

  // The stored contact wins; otherwise the number is matched against the contact book, so a contact saved
  // after the call still names it.
  const byNumber = sql<string | null>`(
    select ${contacts.displayName} from ${contactNumbers}
    inner join ${contacts} on ${contacts.id} = ${contactNumbers.contactId}
    where ${contactNumbers.e164} = ${calls.party} and ${contacts.ownerId} = ${calls.ownerId}
    order by ${contacts.sortKey}, ${contacts.id} limit 1)`;

  const rows = await db
    .select({ call: calls, linkedName: contacts.displayName, matchedName: byNumber })
    .from(calls)
    .leftJoin(contacts, eq(contacts.id, calls.contactId))
    .where(and(...conds))
    .orderBy(desc(happenedAt), desc(calls.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const items: CallEntry[] = page.map(({ call, linkedName, matchedName }) => ({
    id: call.id,
    twilioCallSid: call.twilioCallSid,
    parentCallSid: call.parentCallSid,
    direction: call.direction,
    numberId: call.numberId,
    party: call.party,
    status: call.status,
    startedAt: call.startedAt?.getTime() ?? null,
    answeredAt: call.answeredAt?.getTime() ?? null,
    endedAt: call.endedAt?.getTime() ?? null,
    duration: call.duration,
    errorCode: call.errorCode,
    errorMessage: call.errorMessage,
    contactId: call.contactId,
    contactName: linkedName ?? matchedName ?? null,
    missed: isMissedCall(call),
  }));
  const last = page.at(-1)?.call;
  const body: CallList = {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor([(last.startedAt ?? last.createdAt).getTime(), last.id])
        : null,
  };
  return c.json(body);
});
