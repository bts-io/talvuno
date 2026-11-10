/**
 * The owner's saved short replies, mounted at /api/quick-replies (session and Origin checked by the app).
 *
 *   GET    /       the list (the three defaults are added on the first read)
 *   POST   /       add one
 *   PATCH  /:id    change the text or the position
 *   DELETE /:id    remove one
 */
import { zValidator } from "@hono/zod-validator";
import { and, asc, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  QUICK_REPLY_LIMIT,
  type QuickReply,
  quickReplyInputSchema,
  quickReplyPatchSchema,
} from "../../contracts/messages";
import type { Db } from "../db";
import { quickReplies, quickReplyState } from "../db/schema";
import { ApiError } from "../lib/errors";
import { validationHook } from "../lib/validation";
import type { AppEnv } from "../types";

export const quickRepliesApi = new Hono<AppEnv>();

export const DEFAULT_QUICK_REPLIES = [
  "Can I call you back in a few minutes?",
  "I am busy right now. I will get back to you soon.",
  "Thanks for your message. I will reply shortly.",
] as const;

const columns = { id: quickReplies.id, text: quickReplies.text, sortOrder: quickReplies.sortOrder };

/** Lists the owner's replies, adding the defaults once (the state row is the once-only claim). */
export async function listQuickReplies(db: Db, ownerId: string): Promise<QuickReply[]> {
  const claimed = await db
    .insert(quickReplyState)
    .values({ ownerId })
    .onConflictDoNothing()
    .returning({ ownerId: quickReplyState.ownerId })
    .get();
  if (claimed)
    await db
      .insert(quickReplies)
      .values(DEFAULT_QUICK_REPLIES.map((text, i) => ({ ownerId, text, sortOrder: i })));
  return db
    .select(columns)
    .from(quickReplies)
    .where(eq(quickReplies.ownerId, ownerId))
    .orderBy(asc(quickReplies.sortOrder), asc(quickReplies.createdAt), asc(quickReplies.id))
    .all();
}

quickRepliesApi.get("/", async (c) => {
  c.header("cache-control", "no-store");
  return c.json(await listQuickReplies(c.get("db"), c.get("user")!.id));
});

quickRepliesApi.post("/", zValidator("json", quickReplyInputSchema, validationHook), async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  await listQuickReplies(db, ownerId);
  const [{ n }] = await db
    .select({ n: count() })
    .from(quickReplies)
    .where(eq(quickReplies.ownerId, ownerId))
    .all();
  if (n >= QUICK_REPLY_LIMIT)
    throw new ApiError(409, "too_many", `You can keep up to ${QUICK_REPLY_LIMIT} quick replies`);
  const row = await db
    .insert(quickReplies)
    .values({ ownerId, text: c.req.valid("json").text, sortOrder: n })
    .returning(columns)
    .get();
  return c.json(row satisfies QuickReply, 201);
});

quickRepliesApi.patch("/:id", zValidator("json", quickReplyPatchSchema, validationHook), async (c) => {
  const ownerId = c.get("user")!.id;
  const row = await c
    .get("db")
    .update(quickReplies)
    .set(c.req.valid("json"))
    .where(and(eq(quickReplies.id, c.req.param("id")), eq(quickReplies.ownerId, ownerId)))
    .returning(columns)
    .get();
  if (!row) throw new ApiError(404, "not_found", "Quick reply not found");
  return c.json(row satisfies QuickReply);
});

quickRepliesApi.delete("/:id", async (c) => {
  const ownerId = c.get("user")!.id;
  const row = await c
    .get("db")
    .delete(quickReplies)
    .where(and(eq(quickReplies.id, c.req.param("id")), eq(quickReplies.ownerId, ownerId)))
    .returning({ id: quickReplies.id })
    .get();
  if (!row) throw new ApiError(404, "not_found", "Quick reply not found");
  return c.json({ ok: true });
});
