/**
 * Which of the owner's numbers a call may use. A released number stays in the table for history but can
 * never place or take a call.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db";
import { schema } from "../../db";
import { getPreferences } from "../preferences";

export type NumberRow = typeof schema.phoneNumbers.$inferSelect;

const usable = (n: NumberRow) => !n.releasedAt && n.capabilities?.voice !== false;

/** The owner's numbers that can make and take calls, default first. */
export async function voiceNumbers(db: Db, ownerId: string): Promise<NumberRow[]> {
  const rows = await db
    .select()
    .from(schema.phoneNumbers)
    .where(and(eq(schema.phoneNumbers.ownerId, ownerId), isNull(schema.phoneNumbers.releasedAt)))
    .orderBy(asc(schema.phoneNumbers.createdAt));
  const list = rows.filter(usable);
  const def = await defaultNumber(db, ownerId, list);
  return def ? [def, ...list.filter((n) => n.id !== def.id)] : list;
}

/** The number calls go out from when none is chosen: the preference, else the flagged default, else the first. */
export async function defaultNumber(db: Db, ownerId: string, list?: NumberRow[]): Promise<NumberRow | null> {
  const numbers = list ?? (await voiceNumbers(db, ownerId));
  const prefs = await getPreferences(db, ownerId);
  return (
    numbers.find((n) => n.id === prefs.defaultNumberId) ??
    numbers.find((n) => n.isDefault) ??
    numbers[0] ??
    null
  );
}

/** Our usable number with this E.164, owned by `ownerId`, or null. */
export async function ownNumber(db: Db, ownerId: string, e164: string): Promise<NumberRow | null> {
  const row = await db
    .select()
    .from(schema.phoneNumbers)
    .where(and(eq(schema.phoneNumbers.ownerId, ownerId), eq(schema.phoneNumbers.e164, e164)))
    .get();
  return row && usable(row) ? row : null;
}

/** The usable number a call to `e164` came in on, whoever owns it, or null. */
export async function numberByE164(db: Db, e164: string): Promise<NumberRow | null> {
  const row = await db.select().from(schema.phoneNumbers).where(eq(schema.phoneNumbers.e164, e164)).get();
  return row && usable(row) ? row : null;
}
