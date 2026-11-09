import { eq } from "drizzle-orm";
import type { Preferences } from "../../contracts";
import type { Db } from "../db";
import { schema } from "../db";

/** What a new owner starts with. Matches the column defaults in the user_preferences table. */
export const DEFAULT_PREFERENCES: Preferences = {
  defaultNumberId: null,
  countryAllowlist: [],
  locale: "en",
  theme: "system",
  smsPerHour: 30,
  callsPerHour: 20,
};

/** The owner's preferences, or the defaults when no row exists yet. */
export async function getPreferences(db: Db, ownerId: string): Promise<Preferences> {
  const [row] = await db
    .select()
    .from(schema.userPreferences)
    .where(eq(schema.userPreferences.userId, ownerId))
    .limit(1);
  if (!row) return { ...DEFAULT_PREFERENCES, countryAllowlist: [] };
  return {
    defaultNumberId: row.defaultNumberId,
    countryAllowlist: row.countryAllowlist as Preferences["countryAllowlist"],
    locale: row.locale,
    theme: row.theme,
    smsPerHour: row.smsPerHour,
    callsPerHour: row.callsPerHour,
  };
}

/** Creates the default row for a new owner. Safe to call twice. */
export async function createDefaultPreferences(db: Db, ownerId: string): Promise<void> {
  await db.insert(schema.userPreferences).values({ userId: ownerId }).onConflictDoNothing();
}
