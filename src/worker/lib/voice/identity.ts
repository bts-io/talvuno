/**
 * The Voice client identity of the owner. It is derived from the owner id on the server, never taken from a
 * request, so the browser cannot ask for a token that rings or dials as someone else. Twilio identities are
 * safest as letters, digits and underscores, so anything else in the id is dropped.
 */
import type { Db } from "../../db";
import { schema } from "../../db";

export const IDENTITY_PREFIX = "owner_";

export const voiceIdentity = (ownerId: string) => `${IDENTITY_PREFIX}${ownerId.replace(/[^A-Za-z0-9]/g, "")}`;

/**
 * The owner whose identity sent a TwiML App request (`From=client:<identity>`), or null. There is one owner
 * per deployment, so this compares against every user id instead of trusting anything parsed from the string.
 */
export async function ownerFromClient(db: Db, from: string | undefined): Promise<string | null> {
  if (!from?.startsWith("client:")) return null;
  const identity = from.slice("client:".length);
  if (!identity.startsWith(IDENTITY_PREFIX)) return null;
  const users = await db.select({ id: schema.user.id }).from(schema.user).limit(10);
  return users.find((u) => voiceIdentity(u.id) === identity)?.id ?? null;
}
