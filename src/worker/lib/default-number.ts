import { and, eq, isNull } from "drizzle-orm";
import { type Db, schema } from "../db";
import { ApiError } from "./errors";

const { phoneNumbers, userPreferences } = schema;

/**
 * Makes `numberId` the owner's only default, or none, keeping user_preferences in step with
 * phone_numbers.is_default (the dialer reads the latter). A number must be one of the owner's active
 * numbers, and none is refused while an active number exists. Throws before writing anything.
 */
export async function setDefaultNumber(db: Db, ownerId: string, numberId: string | null) {
  if (numberId) {
    const [row] = await db
      .select({ id: phoneNumbers.id })
      .from(phoneNumbers)
      .where(
        and(
          eq(phoneNumbers.id, numberId),
          eq(phoneNumbers.ownerId, ownerId),
          isNull(phoneNumbers.releasedAt),
        ),
      );
    if (!row) throw new ApiError(400, "invalid", "That number is not one of your active numbers");
  } else {
    const [active] = await db
      .select({ id: phoneNumbers.id })
      .from(phoneNumbers)
      .where(and(eq(phoneNumbers.ownerId, ownerId), isNull(phoneNumbers.releasedAt)))
      .limit(1);
    if (active) throw new ApiError(400, "invalid", "Choose a default number: you still have active numbers");
  }
  // The partial unique index allows one default, so the old one is cleared first.
  await db
    .update(phoneNumbers)
    .set({ isDefault: false })
    .where(and(eq(phoneNumbers.ownerId, ownerId), eq(phoneNumbers.isDefault, true)));
  if (numberId)
    await db
      .update(phoneNumbers)
      .set({ isDefault: true })
      .where(and(eq(phoneNumbers.ownerId, ownerId), eq(phoneNumbers.id, numberId)));
  await db
    .insert(userPreferences)
    .values({ userId: ownerId, defaultNumberId: numberId })
    .onConflictDoUpdate({ target: userPreferences.userId, set: { defaultNumberId: numberId } });
}
