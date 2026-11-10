/**
 * Owner-facing phone menus, mounted at /api/menus (session and Origin checks apply).
 *
 *   GET  /                    the menu of every usable number (off and empty when none was saved)
 *   PUT  /numbers/:numberId   saves the menu of one of the owner's numbers
 *   POST /preview             { prompt } the TwiML a caller would get, as text. Saves nothing.
 *
 * Every forward number is checked with assertDestinationAllowed on each save (format, premium rate, allowlist),
 * and saving never spends from the hourly call budget. The call checks it again, and spends, when a caller
 * presses the key.
 */
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { idSchema } from "../../contracts";
import { menuPreviewInputSchema, type NumberMenu, numberMenuInputSchema } from "../../contracts/menus";
import { schema } from "../db";
import { ApiError } from "../lib/errors";
import { assertDestinationAllowed } from "../lib/twilio/guards";
import { validationHook } from "../lib/validation";
import { menuTwiml, numberMenu } from "../lib/voice/menu";
import { voiceNumbers } from "../lib/voice/numbers";
import type { AppEnv } from "../types";

export const menus = new Hono<AppEnv>();

menus.get("/", async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const numbers = await voiceNumbers(db, ownerId);
  const items: NumberMenu[] = await Promise.all(numbers.map((n) => numberMenu(db, ownerId, n.id)));
  c.header("cache-control", "no-store");
  return c.json({ items });
});

menus.put(
  "/numbers/:numberId",
  zValidator("param", z.object({ numberId: idSchema }), validationHook),
  zValidator("json", numberMenuInputSchema, validationHook),
  async (c) => {
    const db = c.get("db");
    const ownerId = c.get("user")!.id;
    const { numberId } = c.req.valid("param");
    // Only the owner's own numbers: another owner's id reads as not found.
    const number = (await voiceNumbers(db, ownerId)).find((n) => n.id === numberId);
    if (!number) throw new ApiError(404, "not_found", "Number not found");
    const input = c.req.valid("json");

    // Every forward key is checked on save, but saving never spends from the hourly call budget: only a call
    // that really forwards does.
    for (const key of input.keys)
      if (key.action === "forward") await assertDestinationAllowed(c, ownerId, key.to);

    const values = {
      enabled: input.enabled,
      prompt: input.prompt,
      keys: input.keys,
      defaultAction: input.defaultAction,
    };
    await db
      .insert(schema.numberMenus)
      .values({ ownerId, numberId, ...values })
      .onConflictDoUpdate({ target: schema.numberMenus.numberId, set: { ...values, updatedAt: new Date() } });
    return c.json(await numberMenu(db, ownerId, numberId));
  },
);

menus.post("/preview", zValidator("json", menuPreviewInputSchema, validationHook), async (c) => {
  const { prompt } = c.req.valid("json");
  return c.json({ twiml: menuTwiml(c.env, prompt, 1) });
});
