/**
 * The owner's scheduled texts, mounted at /api/scheduled-messages (session and Origin checked by the app).
 *
 *   GET    /?numberId&to&status   the list, soonest first. Default: open ones (scheduled, sending, failed).
 *                                 `status` is one value or a comma list. `numberId` + `to` pick one thread.
 *   POST   /                      schedule a text (sendAt 2 minutes to 1 year ahead)
 *   PATCH  /:id                   change the body and/or time while still scheduled
 *   DELETE /:id                   cancel one that is still scheduled, or dismiss a failed one
 *
 * Texts go out from the cron job (`sendDueScheduled`), within 15 minutes of their time.
 */
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  SCHEDULED_STATUSES,
  type ScheduledMessage,
  scheduleInputSchema,
  schedulePatchSchema,
  sendAtProblem,
} from "../../contracts/scheduled";
import { toE164 } from "../../lib/phone";
import { phoneNumbers, scheduledMessages } from "../db/schema";
import { ApiError } from "../lib/errors";
import { toScheduledMessage } from "../lib/scheduled";
import { validationHook } from "../lib/validation";
import type { AppEnv } from "../types";

export const scheduledMessagesApi = new Hono<AppEnv>();

const LIST_LIMIT = 200;
const OPEN = ["scheduled", "sending", "failed"] as const;

const listQuery = z.object({
  numberId: z.string().max(64).optional(),
  to: z.string().max(64).optional(),
  status: z
    .string()
    .max(100)
    .optional()
    .transform((v, ctx) => {
      if (!v) return [...OPEN];
      const parts = v.split(",");
      if (!parts.every((p) => (SCHEDULED_STATUSES as readonly string[]).includes(p))) {
        ctx.addIssue({ code: "custom", message: "Unknown status" });
        return z.NEVER;
      }
      return parts as (typeof SCHEDULED_STATUSES)[number][];
    }),
});

const sendAtError = (problem: "too_soon" | "too_far") =>
  problem === "too_soon"
    ? new ApiError(400, "send_at_too_soon", "Pick a time at least 2 minutes from now")
    : new ApiError(400, "send_at_too_far", "Pick a time within the next year");

async function ownedRow(c: { get: (k: "db") => AppEnv["Variables"]["db"] }, ownerId: string, id: string) {
  const row = await c
    .get("db")
    .select({ s: scheduledMessages, numberE164: phoneNumbers.e164 })
    .from(scheduledMessages)
    .innerJoin(phoneNumbers, eq(phoneNumbers.id, scheduledMessages.numberId))
    .where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.ownerId, ownerId)))
    .get();
  if (!row) throw new ApiError(404, "not_found", "Scheduled text not found");
  return row;
}

scheduledMessagesApi.get("/", zValidator("query", listQuery, validationHook), async (c) => {
  const ownerId = c.get("user")!.id;
  const { numberId, to, status } = c.req.valid("query");
  const filters = [eq(scheduledMessages.ownerId, ownerId), inArray(scheduledMessages.status, status)];
  if (numberId) filters.push(eq(scheduledMessages.numberId, numberId));
  if (to) filters.push(eq(scheduledMessages.to, toE164(to) ?? to.trim()));
  const rows = await c
    .get("db")
    .select({ s: scheduledMessages, numberE164: phoneNumbers.e164 })
    .from(scheduledMessages)
    .innerJoin(phoneNumbers, eq(phoneNumbers.id, scheduledMessages.numberId))
    .where(and(...filters))
    .orderBy(asc(scheduledMessages.sendAt), asc(scheduledMessages.id))
    .limit(LIST_LIMIT)
    .all();
  return c.json(rows.map((r) => toScheduledMessage(r.s, r.numberE164)) satisfies ScheduledMessage[]);
});

scheduledMessagesApi.post("/", zValidator("json", scheduleInputSchema, validationHook), async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const input = c.req.valid("json");
  const problem = sendAtProblem(input.sendAt);
  if (problem) throw sendAtError(problem);
  const to = toE164(input.to);
  if (!to) throw new ApiError(400, "invalid_number", "Not a valid phone number");
  const number = await db
    .select()
    .from(phoneNumbers)
    .where(
      and(
        eq(phoneNumbers.id, input.numberId),
        eq(phoneNumbers.ownerId, ownerId),
        isNull(phoneNumbers.releasedAt),
      ),
    )
    .get();
  if (!number) throw new ApiError(404, "number_not_found", "That number is not one of yours");
  const row = await db
    .insert(scheduledMessages)
    .values({ ownerId, numberId: number.id, to, body: input.body, sendAt: new Date(input.sendAt) })
    .returning()
    .get();
  return c.json(toScheduledMessage(row, number.e164) satisfies ScheduledMessage, 201);
});

scheduledMessagesApi.patch("/:id", zValidator("json", schedulePatchSchema, validationHook), async (c) => {
  const ownerId = c.get("user")!.id;
  const id = c.req.param("id");
  const patch = c.req.valid("json");
  const current = await ownedRow(c, ownerId, id);
  if (patch.sendAt !== undefined) {
    const problem = sendAtProblem(patch.sendAt);
    if (problem) throw sendAtError(problem);
  }
  // Conditional on `scheduled`: a text the cron job already claimed can no longer change.
  const updated = await c
    .get("db")
    .update(scheduledMessages)
    .set({
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.sendAt !== undefined ? { sendAt: new Date(patch.sendAt) } : {}),
    })
    .where(
      and(
        eq(scheduledMessages.id, id),
        eq(scheduledMessages.ownerId, ownerId),
        eq(scheduledMessages.status, "scheduled"),
      ),
    )
    .returning()
    .get();
  if (!updated) throw new ApiError(409, "not_scheduled", "This text is no longer waiting to be sent");
  return c.json(toScheduledMessage(updated, current.numberE164) satisfies ScheduledMessage);
});

scheduledMessagesApi.delete("/:id", async (c) => {
  const ownerId = c.get("user")!.id;
  const id = c.req.param("id");
  const current = await ownedRow(c, ownerId, id);
  const cancelled = await c
    .get("db")
    .update(scheduledMessages)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(scheduledMessages.id, id),
        eq(scheduledMessages.ownerId, ownerId),
        inArray(scheduledMessages.status, ["scheduled", "failed"]),
      ),
    )
    .returning()
    .get();
  if (!cancelled) throw new ApiError(409, "not_scheduled", "This text is no longer waiting to be sent");
  return c.json(toScheduledMessage(cancelled, current.numberE164) satisfies ScheduledMessage);
});
