/**
 * The morning digest: one push a day, at the owner's chosen local time, counting what happened since the
 * last one. Run by the cron job `sendDigests` every 15 minutes, so it must be idempotent: the local date is
 * claimed with a conditional update before anything is sent.
 */
import { and, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { MISSED_STATUSES } from "../../contracts/contacts";
import { createDb, type Db, schema } from "../db";
import { type DigestCounts, digestBody, digestDue } from "./digest-rules";
import { sendPushToOwner } from "./push";

const { calls, conversations, userPreferences } = schema;

/** With no earlier digest, count the last day. */
const FIRST_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Whether Row B's voicemails table exists yet. Cheap, and keeps the digest working before it lands. */
async function hasVoicemailsTable(db: Db): Promise<boolean> {
  const row = await db.$client
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'voicemails'")
    .first();
  return row !== null;
}

/** Counts for one owner since `since`. Every query is scoped to the owner. */
export async function digestCounts(db: Db, ownerId: string, since: Date): Promise<DigestCounts> {
  const [missed] = await db
    .select({ n: sql<number>`count(*)` })
    .from(calls)
    .where(
      and(
        eq(calls.ownerId, ownerId),
        eq(calls.direction, "inbound"),
        inArray(calls.status, [...MISSED_STATUSES]),
        isNull(calls.answeredAt),
        gt(sql`coalesce(${calls.startedAt}, ${calls.createdAt})`, since.getTime()),
      ),
    );
  const [unread] = await db
    .select({ n: sql<number>`coalesce(sum(${conversations.unreadCount}), 0)` })
    .from(conversations)
    .where(eq(conversations.ownerId, ownerId));

  let voicemails = 0;
  if (await hasVoicemailsTable(db)) {
    try {
      const row = await db.$client
        .prepare("SELECT count(*) AS n FROM voicemails WHERE owner_id = ? AND created_at > ?")
        .bind(ownerId, since.getTime())
        .first<{ n: number }>();
      voicemails = row?.n ?? 0;
    } catch (err) {
      console.error("digest voicemail count failed", { error: String(err) });
    }
  }
  return { missedCalls: Number(missed?.n ?? 0), voicemails, unreadTexts: Number(unread?.n ?? 0) };
}

/** Cron job: sends the digest to every owner whose local time has passed their chosen time today. */
export async function sendDigests(env: Env, _ctx?: ExecutionContext, now = Date.now()): Promise<void> {
  const db = createDb(env.DB);
  const rows = await db.select().from(userPreferences).where(eq(userPreferences.digestEnabled, true));
  for (const p of rows) {
    const { due, date } = digestDue(now, p);
    if (!due) continue;
    // Claim the date first: an overlapping run finds it taken and sends nothing.
    const claimed = await db
      .update(userPreferences)
      .set({ lastDigestDate: date, lastDigestAt: new Date(now) })
      .where(
        and(
          eq(userPreferences.userId, p.userId),
          or(isNull(userPreferences.lastDigestDate), ne(userPreferences.lastDigestDate, date)),
        ),
      )
      .returning({ userId: userPreferences.userId });
    if (claimed.length === 0) continue;

    const since = p.lastDigestAt ?? new Date(now - FIRST_WINDOW_MS);
    const body = digestBody(await digestCounts(db, p.userId, since));
    if (!body) continue;
    await sendPushToOwner(env, p.userId, { title: "Today so far", body, url: "/recents", tag: "digest" });
  }
}
