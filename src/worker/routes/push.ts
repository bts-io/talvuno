import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  pushSubscriptionInputSchema,
  pushUnsubscribeInputSchema,
  type VapidPublicKey,
} from "../../contracts/push";
import { schema } from "../db";
import { ApiError } from "../lib/errors";
import { sendPushToOwner, vapidFromEnv } from "../lib/push";
import { validationHook } from "../lib/validation";
import type { AppEnv } from "../types";

/** Web Push subscriptions for the signed-in owner. Mounted at /api/push (session and Origin checked upstream). */
export const push = new Hono<AppEnv>();

push.get("/vapid-public-key", (c) => {
  c.header("cache-control", "no-store");
  const vapid = vapidFromEnv(c.env);
  return c.json({ publicKey: vapid?.publicKey ?? null } satisfies VapidPublicKey);
});

/** Upsert by endpoint. An endpoint belongs to one browser profile, so a re-subscribe replaces its keys. */
push.post("/subscriptions", zValidator("json", pushSubscriptionInputSchema, validationHook), async (c) => {
  const ownerId = c.get("user")!.id;
  const input = c.req.valid("json");
  const userAgent = c.req.header("user-agent")?.slice(0, 300) ?? null;
  await c
    .get("db")
    .insert(schema.pushSubscriptions)
    .values({
      ownerId,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent,
    })
    .onConflictDoUpdate({
      target: schema.pushSubscriptions.endpoint,
      set: { ownerId, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent },
    });
  return c.json({ ok: true }, 201);
});

push.delete("/subscriptions", zValidator("json", pushUnsubscribeInputSchema, validationHook), async (c) => {
  const ownerId = c.get("user")!.id;
  const { endpoint } = c.req.valid("json");
  await c
    .get("db")
    .delete(schema.pushSubscriptions)
    .where(
      and(eq(schema.pushSubscriptions.ownerId, ownerId), eq(schema.pushSubscriptions.endpoint, endpoint)),
    );
  return c.json({ ok: true });
});

/** Sends a test notice to this owner's devices only. */
push.post("/test", async (c) => {
  if (!vapidFromEnv(c.env)) throw new ApiError(503, "push_not_configured", "Web Push keys are not set");
  const ownerId = c.get("user")!.id;
  const result = await sendPushToOwner(c.env, ownerId, {
    title: "Talvuno",
    body: "Notifications work on this device.",
    url: "/settings",
    tag: "talvuno-test",
  });
  return c.json(result);
});
