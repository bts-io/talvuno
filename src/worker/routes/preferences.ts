import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { preferencesSchema } from "../../contracts";
import { SUPPORTED_LOCALES } from "../../shared/i18n";
import { schema } from "../db";
import { setDefaultNumber } from "../lib/default-number";
import { getPreferences } from "../lib/preferences";
import { validationHook } from "../lib/validation";
import type { AppEnv } from "../types";

/** The owner's preferences. Mounted at /api/preferences. */
export const preferences = new Hono<AppEnv>();

const localeCodes: string[] = SUPPORTED_LOCALES.map((l) => l.code);

/** Every field optional: the settings sections save their own fields. Unknown fields are rejected. */
const updateSchema = preferencesSchema
  .partial()
  .strict()
  .refine((v) => v.locale === undefined || localeCodes.includes(v.locale), {
    path: ["locale"],
    message: "Unsupported language",
  });

preferences.get("/", async (c) => {
  c.header("cache-control", "no-store");
  return c.json(await getPreferences(c.get("db"), c.get("user")!.id));
});

preferences.put("/", zValidator("json", updateSchema, validationHook), async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const input = c.req.valid("json");
  const { defaultNumberId, countryAllowlist, ...rest } = input;

  // Validates first, so a refused default writes nothing.
  if (defaultNumberId !== undefined) await setDefaultNumber(db, ownerId, defaultNumberId);

  const set = {
    ...rest,
    ...(countryAllowlist ? { countryAllowlist: [...new Set(countryAllowlist)].sort() } : {}),
  };
  await db
    .insert(schema.userPreferences)
    .values({ userId: ownerId, ...set })
    .onConflictDoUpdate({ target: schema.userPreferences.userId, set: { ...set, updatedAt: new Date() } });
  return c.json(await getPreferences(db, ownerId));
});
