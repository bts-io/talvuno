/**
 * The per-number missed-call text setting, mounted at /api/missed-call-text.
 *
 *   GET /             one entry per active number (off unless the owner turned it on)
 *   PUT /:numberId    { enabled, text } for one of the owner's numbers
 */
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { type MissedCallText, missedCallTextInputSchema } from "../../contracts/messages";
import type { Db } from "../db";
import { missedCallSettings, phoneNumbers } from "../db/schema";
import { ApiError } from "../lib/errors";
import { DEFAULT_MISSED_CALL_TEXT } from "../lib/missed-call";
import { validationHook } from "../lib/validation";
import type { AppEnv } from "../types";

export const missedCallTextApi = new Hono<AppEnv>();

async function list(db: Db, ownerId: string): Promise<MissedCallText[]> {
  const rows = await db
    .select({
      numberId: phoneNumbers.id,
      e164: phoneNumbers.e164,
      friendlyName: phoneNumbers.friendlyName,
      enabled: missedCallSettings.enabled,
      text: missedCallSettings.text,
    })
    .from(phoneNumbers)
    .leftJoin(missedCallSettings, eq(missedCallSettings.numberId, phoneNumbers.id))
    .where(and(eq(phoneNumbers.ownerId, ownerId), isNull(phoneNumbers.releasedAt)))
    .orderBy(phoneNumbers.e164)
    .all();
  return rows.map((r) => ({ ...r, enabled: r.enabled ?? false, text: r.text || DEFAULT_MISSED_CALL_TEXT }));
}

missedCallTextApi.get("/", async (c) => {
  c.header("cache-control", "no-store");
  return c.json(await list(c.get("db"), c.get("user")!.id));
});

missedCallTextApi.put(
  "/:numberId",
  zValidator("json", missedCallTextInputSchema, validationHook),
  async (c) => {
    const db = c.get("db");
    const ownerId = c.get("user")!.id;
    const numberId = c.req.param("numberId");
    const { enabled, text } = c.req.valid("json");
    const number = await db
      .select({ id: phoneNumbers.id })
      .from(phoneNumbers)
      .where(
        and(
          eq(phoneNumbers.id, numberId),
          eq(phoneNumbers.ownerId, ownerId),
          isNull(phoneNumbers.releasedAt),
        ),
      )
      .get();
    if (!number) throw new ApiError(404, "number_not_found", "That number is not one of yours");
    if (enabled && !text) throw new ApiError(400, "invalid_request", "Write the text to send first");
    const set = { enabled, text, updatedAt: new Date() };
    await db
      .insert(missedCallSettings)
      .values({ numberId, ownerId, ...set })
      .onConflictDoUpdate({ target: missedCallSettings.numberId, set });
    const all = await list(db, ownerId);
    return c.json(all.find((n) => n.numberId === numberId));
  },
);
