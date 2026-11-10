/**
 * Owner-facing call routing, mounted at /api/routing (session and Origin checks apply).
 *
 *   GET    /                    do not disturb, plus ring time, greeting and hours of every usable number
 *   PUT    /dnd                 { dnd } turns do not disturb on or off
 *   PUT    /numbers/:numberId   ring time, greeting and hours of one of the owner's numbers
 *   GET    /blocked             the block list, newest first
 *   POST   /blocked             { address } blocks a caller or sender (blocking twice is fine)
 *   DELETE /blocked/:address    unblocks it
 *   GET    /incoming            calls waiting for an answer right now
 *   POST   /incoming/:id/decline  sends a waiting call to voicemail
 */
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { idSchema } from "../../contracts";
import {
  type BlockedNumber,
  blockInputSchema,
  type IncomingCallInfo,
  type NumberRouting,
  numberRoutingInputSchema,
  routingSettingsSchema,
} from "../../contracts/routing";
import { schema } from "../db";
import { findContactByNumber } from "../lib/contacts";
import { ApiError } from "../lib/errors";
import { notifyOwner } from "../lib/hub";
import { validationHook } from "../lib/validation";
import { isWithheld } from "../lib/voice/calls";
import { voiceNumbers } from "../lib/voice/numbers";
import { declineWaitingCall, isDndOn, numberRouting, waitingCalls } from "../lib/voice/routing";
import type { AppEnv } from "../types";

export const routing = new Hono<AppEnv>();

routing.get("/", async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const numbers = await voiceNumbers(db, ownerId);
  const list: NumberRouting[] = await Promise.all(
    numbers.map(async (n) => ({ numberId: n.id, ...(await numberRouting(db, ownerId, n.id)) })),
  );
  c.header("cache-control", "no-store");
  return c.json({ dnd: await isDndOn(db, ownerId), numbers: list });
});

routing.put("/dnd", zValidator("json", routingSettingsSchema.strict(), validationHook), async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const { dnd } = c.req.valid("json");
  await db
    .insert(schema.routingSettings)
    .values({ ownerId, dnd })
    .onConflictDoUpdate({ target: schema.routingSettings.ownerId, set: { dnd, updatedAt: new Date() } });
  return c.json({ dnd });
});

routing.put(
  "/numbers/:numberId",
  zValidator("param", z.object({ numberId: idSchema }), validationHook),
  zValidator("json", numberRoutingInputSchema.strict(), validationHook),
  async (c) => {
    const db = c.get("db");
    const ownerId = c.get("user")!.id;
    const { numberId } = c.req.valid("param");
    // Only the owner's own numbers: another owner's id reads as not found.
    const number = (await voiceNumbers(db, ownerId)).find((n) => n.id === numberId);
    if (!number) throw new ApiError(404, "not_found", "Number not found");
    const input = c.req.valid("json");
    const set: Partial<typeof schema.numberRouting.$inferInsert> = {};
    if (input.ringSeconds !== undefined) set.ringSeconds = input.ringSeconds;
    if (input.voicemailGreeting !== undefined) set.voicemailGreeting = input.voicemailGreeting;
    if (input.hours !== undefined) set.hours = input.hours;
    await db
      .insert(schema.numberRouting)
      .values({ ownerId, numberId, ...set })
      .onConflictDoUpdate({ target: schema.numberRouting.numberId, set: { ...set, updatedAt: new Date() } });
    const body: NumberRouting = { numberId, ...(await numberRouting(db, ownerId, numberId)) };
    return c.json(body);
  },
);

routing.get("/blocked", async (c) => {
  const rows = await c
    .get("db")
    .select()
    .from(schema.blockedNumbers)
    .where(eq(schema.blockedNumbers.ownerId, c.get("user")!.id))
    .orderBy(desc(schema.blockedNumbers.createdAt));
  const items: BlockedNumber[] = rows.map((r) => ({
    id: r.id,
    address: r.e164,
    createdAt: r.createdAt.getTime(),
  }));
  c.header("cache-control", "no-store");
  return c.json({ items });
});

routing.post("/blocked", zValidator("json", blockInputSchema.strict(), validationHook), async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const { address } = c.req.valid("json");
  await db.insert(schema.blockedNumbers).values({ ownerId, e164: address }).onConflictDoNothing();
  return c.json({ address, blocked: true });
});

routing.delete(
  "/blocked/:address",
  zValidator("param", z.object({ address: z.string().min(1).max(64) }), validationHook),
  async (c) => {
    const { address } = c.req.valid("param");
    await c
      .get("db")
      .delete(schema.blockedNumbers)
      .where(
        and(eq(schema.blockedNumbers.ownerId, c.get("user")!.id), eq(schema.blockedNumbers.e164, address)),
      );
    return c.json({ address, blocked: false });
  },
);

routing.get("/incoming", async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const rows = await waitingCalls(db, ownerId);
  const items: IncomingCallInfo[] = await Promise.all(
    rows.map(async (r) => ({
      callId: r.id,
      party: r.party,
      contactName: isWithheld(r.party)
        ? null
        : ((await findContactByNumber(db, ownerId, r.party))?.displayName ?? null),
      numberId: r.numberId,
      startedAt: (r.startedAt ?? r.createdAt).getTime(),
    })),
  );
  c.header("cache-control", "no-store");
  return c.json({ items });
});

routing.post(
  "/incoming/:id/decline",
  zValidator("param", z.object({ id: idSchema }), validationHook),
  async (c) => {
    const ownerId = c.get("user")!.id;
    const row = await declineWaitingCall(c.get("db"), ownerId, c.req.valid("param").id);
    if (!row) throw new ApiError(409, "not_waiting", "This call was already answered or has ended");
    await notifyOwner(c.env, ownerId, { type: "incoming", callId: row.id, state: "ended" }, c.executionCtx);
    return c.json({ declined: true });
  },
);
