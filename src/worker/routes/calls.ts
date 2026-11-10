import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  type CallEntry,
  type CallList,
  callListQuerySchema,
  isMissedCall,
  MISSED_STATUSES,
  NOT_MISSED_OUTCOMES,
} from "../../contracts/contacts";
import { callingCodeOf } from "../../lib/phone";
import { schema } from "../db";
import { summariesEnabled } from "../lib/ai/summary";
import { decodeCursor, encodeCursor } from "../lib/contacts";
import { likeEscape } from "../lib/sms";
import { validationHook } from "../lib/validation";
import type { AppEnv } from "../types";

const { aiSummaries, calls, contacts, contactNumbers, phoneNumbers, voicemails } = schema;

/** What a person types into a phone search: digits and the usual separators only. */
const PHONE_LIKE = /^[\d\s+().-]+$/;

/**
 * The digit strings a typed number can match against the digits of a stored E.164 party. "0412 345" gives
 * "0412345" and, with a default country code of 61, "61412345". Names and words give none.
 */
export function phoneSearchDigits(q: string, callingCode: string | null): string[] {
  if (!PHONE_LIKE.test(q)) return [];
  const digits = q.replace(/\D/g, "");
  if (!digits) return [];
  // "00" is the international prefix: the rest is already country code plus number.
  if (digits.startsWith("00")) return digits.length > 2 ? [digits.slice(2)] : [];
  const out = [digits];
  if (digits.startsWith("0") && callingCode && digits.length > 1)
    out.push(`${callingCode}${digits.slice(1)}`);
  return out;
}

/** A finished AI summary of one of the call's recordings or of its voicemail whose text matches `pattern`. */
function summaryMatch(ownerId: string, pattern: string) {
  const text = sql`(coalesce(${aiSummaries.summary}, '') || ' ' || coalesce(${aiSummaries.oneLiner}, '') || ' ' || coalesce(${aiSummaries.actionItems}, ''))`;
  return sql`exists (select 1 from ${aiSummaries} where ${aiSummaries.ownerId} = ${ownerId} and ${aiSummaries.status} = 'done' and ${text} like ${pattern} escape '\\' and (
    (${aiSummaries.sourceKind} = 'call' and ${aiSummaries.sourceId} in (select ${schema.callRecordings.id} from ${schema.callRecordings} where ${schema.callRecordings.callId} = ${calls.id} and ${schema.callRecordings.ownerId} = ${ownerId}))
    or (${aiSummaries.sourceKind} = 'voicemail' and ${aiSummaries.sourceId} in (select ${voicemails.id} from ${voicemails} where ${voicemails.callId} = ${calls.id} and ${voicemails.ownerId} = ${ownerId}))))`;
}

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
  const { filter, q, cursor, limit } = c.req.valid("query");

  // With summaries off no summary text is shown or searched, including summaries made while they were on.
  const showSummaries = await summariesEnabled(db, ownerId);

  const conds = [eq(calls.ownerId, ownerId)];
  if (filter === "missed") {
    // The SQL form of isMissedCall.
    conds.push(
      eq(calls.direction, "inbound"),
      inArray(calls.status, [...MISSED_STATUSES]),
      isNull(calls.answeredAt),
      or(
        isNull(calls.outcome),
        notInArray(calls.outcome, [...NOT_MISSED_OUTCOMES]),
      ) as (typeof conds)[number],
    );
  }
  if (q) {
    // One correlated EXISTS keeps the search a single query. The owner check on the recording row sits next
    // to the call's own.
    const pattern = `%${likeEscape(q)}%`;
    // A number typed the way people type it ("0412 345", "+61 412") is matched on digits, reading a leading 0
    // in the country of the owner's default number. Without a default number only the digits are used.
    const [defaultNumber] = await db
      .select({ e164: phoneNumbers.e164 })
      .from(phoneNumbers)
      .where(
        and(
          eq(phoneNumbers.ownerId, ownerId),
          eq(phoneNumbers.isDefault, true),
          isNull(phoneNumbers.releasedAt),
        ),
      )
      .limit(1);
    const callingCode = defaultNumber ? callingCodeOf(defaultNumber.e164) : null;
    const digitMatches = phoneSearchDigits(q, callingCode).map(
      (d) => sql`replace(${calls.party}, '+', '') like ${`%${d}%`}`,
    );
    conds.push(
      or(
        sql`${calls.party} like ${pattern} escape '\\'`,
        ...digitMatches,
        // The contact's name, stored on the call or found by the number, owner-scoped like the lookup above.
        sql`(${contacts.ownerId} = ${ownerId} and ${contacts.displayName} like ${pattern} escape '\\')`,
        sql`exists (select 1 from ${contactNumbers} inner join ${contacts} as named on named.id = ${contactNumbers.contactId} where ${contactNumbers.e164} = ${calls.party} and named.owner_id = ${ownerId} and named.display_name like ${pattern} escape '\\')`,
        sql`exists (select 1 from ${schema.callRecordings} where ${schema.callRecordings.callId} = ${calls.id} and ${schema.callRecordings.ownerId} = ${ownerId} and ${schema.callRecordings.transcript} like ${pattern} escape '\\')`,
        // The AI summaries of the call's recordings and of the voicemail left on it, only while summaries are on.
        ...(showSummaries ? [summaryMatch(ownerId, pattern)] : []),
      ) as (typeof conds)[number],
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

  const recorded = sql<number>`exists (select 1 from ${schema.callRecordings} where ${schema.callRecordings.callId} = ${calls.id})`;

  // What the caller wanted, from the AI summary of the voicemail left on this call.
  const wanted = showSummaries
    ? sql<string | null>`(
    select ${aiSummaries.oneLiner} from ${voicemails}
    inner join ${aiSummaries} on ${aiSummaries.ownerId} = ${voicemails.ownerId}
      and ${aiSummaries.sourceKind} = 'voicemail' and ${aiSummaries.sourceId} = ${voicemails.id}
      and ${aiSummaries.status} in ('done', 'empty')
    where ${voicemails.callId} = ${calls.id} and ${voicemails.ownerId} = ${calls.ownerId}
    limit 1)`
    : sql<string | null>`null`;

  const rows = await db
    .select({ call: calls, linkedName: contacts.displayName, matchedName: byNumber, recorded, wanted })
    .from(calls)
    .leftJoin(contacts, eq(contacts.id, calls.contactId))
    .where(and(...conds))
    .orderBy(desc(happenedAt), desc(calls.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const items: CallEntry[] = page.map(({ call, linkedName, matchedName, recorded, wanted }) => ({
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
    outcome: call.outcome,
    onHoldAt: call.onHoldAt?.getTime() ?? null,
    transferredTo: call.transferredTo,
    transferStatus: call.transferStatus,
    transferDuration: call.transferDuration,
    contactName: linkedName ?? matchedName ?? null,
    missed: isMissedCall(call),
    recorded: Boolean(recorded),
    whatTheyWanted: wanted ?? null,
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
