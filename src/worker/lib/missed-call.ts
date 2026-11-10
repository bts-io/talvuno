/**
 * The automatic text after a missed call. `onMissedCall` is called once from calls.ts, at the point where a
 * call first becomes missed. It texts the caller at most once per number per UTC day, only when the number's
 * setting is on, never to a withheld or non-E.164 caller, never to a blocked number, and always through the
 * same guards and send path as a text the owner types.
 */
import { and, eq, isNull } from "drizzle-orm";
import { isE164 } from "../../lib/phone";
import { createDb, type Db } from "../db";
import { missedCallSettings, missedCallTexts, phoneNumbers } from "../db/schema";
import { deliverSms } from "./send-sms";
import type { CallRow } from "./voice/call-rules";

export const DEFAULT_MISSED_CALL_TEXT = "Sorry I missed your call. I will get back to you soon.";

/** UTC calendar day of `at`, the "once a day" bucket. */
export const dayKey = (at: Date) => at.toISOString().slice(0, 10);

/**
 * True when the owner blocked this caller. The block list belongs to the inbound routing work and may not
 * exist yet: a missing table or column counts as "not blocked". It reads `blocked_numbers (owner_id, e164)`.
 */
export async function isBlocked(env: Env, ownerId: string, e164: string): Promise<boolean> {
  try {
    const hit = await env.DB.prepare(
      "SELECT 1 AS hit FROM blocked_numbers WHERE owner_id = ? AND e164 = ? LIMIT 1",
    )
      .bind(ownerId, e164)
      .first();
    return Boolean(hit);
  } catch {
    return false;
  }
}

async function sendMissedCallText(
  env: Env,
  ownerId: string,
  row: CallRow,
  ctx?: Pick<ExecutionContext, "waitUntil">,
) {
  if (!row.numberId || !isE164(row.party)) return;
  const db: Db = createDb(env.DB);
  const setting = await db
    .select()
    .from(missedCallSettings)
    .where(and(eq(missedCallSettings.numberId, row.numberId), eq(missedCallSettings.ownerId, ownerId)))
    .get();
  const body = setting?.text.trim();
  if (!setting?.enabled || !body) return;
  const number = await db
    .select()
    .from(phoneNumbers)
    .where(
      and(
        eq(phoneNumbers.id, row.numberId),
        eq(phoneNumbers.ownerId, ownerId),
        isNull(phoneNumbers.releasedAt),
      ),
    )
    .get();
  if (!number) return;
  if (await isBlocked(env, ownerId, row.party)) return;

  // The unique key (number, caller, day) makes "once a day" atomic: only one racing call gets the claim.
  const claim = await db
    .insert(missedCallTexts)
    .values({ ownerId, numberId: number.id, caller: row.party, day: dayKey(new Date()) })
    .onConflictDoNothing()
    .returning({ id: missedCallTexts.id })
    .get();
  if (!claim) return;
  try {
    const sent = await deliverSms({ env, db, ctx }, ownerId, number, row.party, body, crypto.randomUUID());
    // A text Twilio refused did not reach the caller: let the next missed call today try again.
    if (sent.row.status === "failed")
      await db.delete(missedCallTexts).where(eq(missedCallTexts.id, claim.id));
  } catch (err) {
    // A guard refused it (country, rate limit): nothing was sent, so release the claim.
    await db.delete(missedCallTexts).where(eq(missedCallTexts.id, claim.id));
    console.warn("missed-call text not sent", { callId: row.id, error: String(err) });
  }
}

/** Never throws: a failed auto-reply must not disturb call handling. With `ctx` it runs after the response. */
export async function onMissedCall(
  env: Env,
  ownerId: string,
  row: CallRow,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const work = sendMissedCallText(env, ownerId, row, ctx).catch((err) =>
    console.error("missed-call text failed", { callId: row.id, error: String(err) }),
  );
  if (ctx) ctx.waitUntil(work);
  else await work;
}
