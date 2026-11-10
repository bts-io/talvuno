/**
 * Activity stats for the owner, read only. Days are the owner's local days (the digest time zone). SQLite
 * cannot bucket by an IANA zone, so each query groups by 15-minute UTC bucket (every zone offset is a
 * multiple of 15 minutes, so a bucket never straddles local midnight) and the buckets are folded into local
 * days here. Rows returned are bounded by real activity, not by the range. Indexes used: calls_owner_started_idx,
 * messages_owner_created_idx, voicemails_owner_created_idx.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { MISSED_STATUSES, NOT_MISSED_OUTCOMES } from "../../contracts/contacts";
import type { Stats, StatsDay } from "../../contracts/stats";
import type { Db } from "../db";
import { schema } from "../db";
import { listDates, localDate, type ResolvedRange } from "./stats-rules";

const { calls, messages, conversations, voicemails, contacts, contactNumbers } = schema;

const BUCKET_MS = 15 * 60_000;
const TOP_CONTACTS = 5;

const list = (xs: readonly string[]) =>
  sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  );

/** When a call happened: its start, else its creation. */
const callAt = sql`coalesce(${calls.startedAt}, ${calls.createdAt})`;

/** Range test that keeps calls_owner_started_idx usable. */
const callInRange = (r: ResolvedRange) =>
  sql`((${calls.startedAt} >= ${r.startMs} and ${calls.startedAt} < ${r.endMs}) or (${calls.startedAt} is null and ${calls.createdAt} >= ${r.startMs} and ${calls.createdAt} < ${r.endMs}))`;

/** The SQL form of isMissedCall (contracts/contacts.ts). */
const isMissedSql = sql`(${calls.direction} = 'inbound' and ${calls.status} in (${list(MISSED_STATUSES)}) and ${calls.answeredAt} is null and (${calls.outcome} is null or ${calls.outcome} not in (${list(NOT_MISSED_OUTCOMES)})))`;

/** An outbound text that never left (failed, undelivered or canceled) is not counted as sent. */
const textCountsSql = sql`(${messages.direction} = 'inbound' or ${messages.status} not in ('failed', 'undelivered', 'canceled'))`;

const num = (v: unknown) => Number(v ?? 0);

export async function computeStats(
  db: Db,
  ownerId: string,
  range: ResolvedRange,
  numberId: string | undefined,
): Promise<Stats> {
  const callBucket = sql<number>`cast(${callAt} / ${BUCKET_MS} as integer)`;
  const msgBucket = sql<number>`cast(${messages.createdAt} / ${BUCKET_MS} as integer)`;
  const vmBucket = sql<number>`cast(${voicemails.createdAt} / ${BUCKET_MS} as integer)`;

  const callConds = [eq(calls.ownerId, ownerId), callInRange(range)];
  if (numberId) callConds.push(eq(calls.numberId, numberId));
  const msgConds = [
    eq(messages.ownerId, ownerId),
    sql`${messages.createdAt} >= ${range.startMs} and ${messages.createdAt} < ${range.endMs}`,
    textCountsSql,
  ];
  if (numberId) msgConds.push(eq(conversations.numberId, numberId));
  const vmConds = [
    eq(voicemails.ownerId, ownerId),
    sql`${voicemails.createdAt} >= ${range.startMs} and ${voicemails.createdAt} < ${range.endMs}`,
  ];
  if (numberId) vmConds.push(eq(voicemails.numberId, numberId));

  const msgParty = sql<string>`case when ${messages.direction} = 'inbound' then ${messages.from} else ${messages.to} end`;

  const [callRows, msgRows, vmRows, callParties, msgParties, vmParties] = await Promise.all([
    db
      .select({
        bucket: callBucket,
        direction: calls.direction,
        n: sql<number>`count(*)`,
        blocked: sql<number>`sum(case when ${calls.direction} = 'inbound' and ${calls.outcome} = 'blocked' then 1 else 0 end)`,
        missed: sql<number>`sum(case when ${isMissedSql} then 1 else 0 end)`,
        answered: sql<number>`sum(case when ${calls.answeredAt} is not null and ${calls.duration} is not null then 1 else 0 end)`,
        seconds: sql<number>`sum(case when ${calls.answeredAt} is not null and ${calls.duration} is not null then ${calls.duration} else 0 end)`,
      })
      .from(calls)
      .where(and(...callConds))
      .groupBy(callBucket, calls.direction),
    db
      .select({ bucket: msgBucket, direction: messages.direction, n: sql<number>`count(*)` })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(...msgConds))
      .groupBy(msgBucket, messages.direction),
    db
      .select({ bucket: vmBucket, n: sql<number>`count(*)` })
      .from(voicemails)
      .where(and(...vmConds))
      .groupBy(vmBucket),
    db
      .select({ party: calls.party, n: sql<number>`count(*)` })
      .from(calls)
      .where(and(...callConds))
      .groupBy(calls.party),
    db
      .select({ party: msgParty, n: sql<number>`count(*)` })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(...msgConds))
      .groupBy(msgParty),
    db
      .select({ party: voicemails.from, n: sql<number>`count(*)` })
      .from(voicemails)
      .where(and(...vmConds))
      .groupBy(voicemails.from),
  ]);

  const tz = range.timeZone;
  const byDate = new Map<string, StatsDay>(
    listDates(range.from, range.days).map((date) => [
      date,
      { date, callsInbound: 0, callsOutbound: 0, missed: 0, textsSent: 0, textsReceived: 0, voicemails: 0 },
    ]),
  );
  const dayOf = (bucket: number) => byDate.get(localDate(num(bucket) * BUCKET_MS, tz));

  let answered = 0;
  let seconds = 0;
  let blocked = 0;
  for (const r of callRows) {
    const day = dayOf(r.bucket);
    if (!day) continue;
    if (r.direction === "inbound") day.callsInbound += num(r.n);
    else day.callsOutbound += num(r.n);
    day.missed += num(r.missed);
    blocked += num(r.blocked);
    answered += num(r.answered);
    seconds += num(r.seconds);
  }
  for (const r of msgRows) {
    const day = dayOf(r.bucket);
    if (!day) continue;
    if (r.direction === "inbound") day.textsReceived += num(r.n);
    else day.textsSent += num(r.n);
  }
  for (const r of vmRows) {
    const day = dayOf(r.bucket);
    if (day) day.voicemails += num(r.n);
  }

  const days = [...byDate.values()];
  const sum = (k: keyof Omit<StatsDay, "date">) => days.reduce((a, d) => a + d[k], 0);
  const callsInbound = sum("callsInbound");
  const missed = sum("missed");
  // The missed rate leaves blocked calls out of the total (spam must not move it). Declined calls stay in,
  // counted as handled.
  const callsInboundRated = callsInbound - blocked;

  const tally = new Map<string, { calls: number; texts: number; voicemails: number }>();
  const bump = (party: string, key: "calls" | "texts" | "voicemails", n: unknown) => {
    const cur = tally.get(party) ?? { calls: 0, texts: 0, voicemails: 0 };
    cur[key] += num(n);
    tally.set(party, cur);
  };
  for (const r of callParties) bump(r.party, "calls", r.n);
  for (const r of msgParties) bump(r.party, "texts", r.n);
  for (const r of vmParties) bump(r.party, "voicemails", r.n);
  const top = [...tally.entries()]
    .map(([party, c]) => ({ party, ...c, total: c.calls + c.texts + c.voicemails }))
    .sort((a, b) => b.total - a.total || a.party.localeCompare(b.party))
    .slice(0, TOP_CONTACTS);

  const names = new Map<string, string>();
  if (top.length) {
    const found = await db
      .select({ e164: contactNumbers.e164, name: contacts.displayName })
      .from(contactNumbers)
      .innerJoin(contacts, eq(contacts.id, contactNumbers.contactId))
      .where(
        and(
          eq(contacts.ownerId, ownerId),
          inArray(
            contactNumbers.e164,
            top.map((t) => t.party),
          ),
        ),
      )
      .orderBy(contacts.sortKey, contacts.id);
    for (const f of found) if (!names.has(f.e164)) names.set(f.e164, f.name);
  }

  return {
    range: { from: range.from, to: range.to, timeZone: tz, days: range.days },
    totals: {
      calls: callsInbound + sum("callsOutbound"),
      callsInbound,
      callsOutbound: sum("callsOutbound"),
      missed,
      callsInboundRated,
      missedRate: callsInboundRated > 0 ? missed / callsInboundRated : null,
      answered,
      avgAnsweredSeconds: answered > 0 ? seconds / answered : null,
      textsSent: sum("textsSent"),
      textsReceived: sum("textsReceived"),
      voicemails: sum("voicemails"),
    },
    days,
    topContacts: top.map((t) => ({ ...t, name: names.get(t.party) ?? null })),
  };
}
