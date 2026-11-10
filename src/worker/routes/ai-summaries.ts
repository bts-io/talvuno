/**
 * AI summary settings. Mounted at /api/ai-summaries, behind the owner session like every /api route.
 *
 *   GET /settings   whether summaries are on
 *   PUT /settings
 */
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { type AiSummarySettings, aiSummarySettingsSchema } from "../../contracts/ai-summary";
import { schema } from "../db";
import { summariesEnabled } from "../lib/ai/summary";
import { validationHook } from "../lib/validation";
import type { AppEnv } from "../types";

const { aiSummarySettings } = schema;

export const aiSummariesRouter = new Hono<AppEnv>();

aiSummariesRouter.get("/settings", async (c) => {
  c.header("cache-control", "no-store");
  const body: AiSummarySettings = { enabled: await summariesEnabled(c.get("db"), c.get("user")!.id) };
  return c.json(body);
});

aiSummariesRouter.put("/settings", zValidator("json", aiSummarySettingsSchema, validationHook), async (c) => {
  const ownerId = c.get("user")!.id;
  const { enabled } = c.req.valid("json");
  await c
    .get("db")
    .insert(aiSummarySettings)
    .values({ ownerId, enabled })
    .onConflictDoUpdate({ target: aiSummarySettings.ownerId, set: { enabled, updatedAt: new Date() } });
  const body: AiSummarySettings = { enabled };
  return c.json(body);
});
