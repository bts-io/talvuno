import { zValidator } from "@hono/zod-validator";
import { count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Me, type SetupStatus, setupInputSchema } from "../../contracts";
import { schema } from "../db";
import { ApiError } from "../lib/errors";
import { createDefaultPreferences } from "../lib/preferences";
import { validationHook } from "../lib/validation";
import { requireOwner } from "../middleware";
import type { AppEnv } from "../types";

/** Constant-time string comparison: both sides are hashed first, so length does not leak either. */
async function tokensMatch(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** First-run setup and the signed-in owner. Mounted at /api. */
export const account = new Hono<AppEnv>();

account.get("/setup", async (c) => {
  const [row] = await c.get("db").select({ n: count() }).from(schema.ownerClaim);
  c.header("cache-control", "no-store");
  return c.json({ needed: (row?.n ?? 0) === 0 } satisfies SetupStatus);
});

/**
 * Creates the owner and signs them in. Works once: after that the owner_claim row exists and Better Auth's
 * user-create hook refuses any second account, so this answers 409.
 */
account.post("/setup", zValidator("json", setupInputSchema, validationHook), async (c) => {
  const auth = c.get("auth");
  if (!auth) throw new ApiError(503, "not_configured", "BETTER_AUTH_SECRET is not set");
  const expected = c.env.SETUP_TOKEN;
  if (!expected) throw new ApiError(503, "setup_not_configured", "SETUP_TOKEN not configured");
  const { setupToken, ...input } = c.req.valid("json");
  if (!(await tokensMatch(setupToken, expected)))
    throw new ApiError(403, "invalid_setup_token", "The setup token is wrong");
  const db = c.get("db");
  const [row] = await db.select({ n: count() }).from(schema.ownerClaim);
  if ((row?.n ?? 0) > 0) throw new ApiError(409, "already_set_up", "This Talvuno already has an owner");
  const email = input.email.toLowerCase();
  const out = await auth.api
    .signUpEmail({ body: input, headers: c.req.raw.headers, returnHeaders: true })
    .catch(async (err: unknown) => {
      const [claim] = await db.select().from(schema.ownerClaim);
      if (claim) {
        // Our own claim, but no user came of it (sign-up failed after the claim insert): release the claim so
        // setup can be retried. Otherwise another request holds the claim, and this one lost the race.
        const [made] = await db.select({ id: schema.user.id }).from(schema.user).limit(1);
        if (claim.email === email && !made) {
          await db.delete(schema.ownerClaim).where(eq(schema.ownerClaim.id, claim.id));
          throw err;
        }
        throw new ApiError(409, "already_set_up", "This Talvuno already has an owner");
      }
      throw err;
    });
  const user = out.response.user;
  await c
    .get("db")
    .insert(schema.auditEvents)
    .values({
      ownerId: user.id,
      actor: "owner",
      action: "owner.setup",
      ip: c.req.header("cf-connecting-ip"),
    });
  await createDefaultPreferences(db, user.id);
  const res = c.json({ id: user.id, name: user.name, email: user.email } satisfies Me, 201);
  for (const cookie of out.headers.getSetCookie()) res.headers.append("set-cookie", cookie);
  res.headers.set("cache-control", "no-store");
  return res;
});

account.get("/me", requireOwner, (c) => {
  const user = c.get("user")!;
  c.header("cache-control", "no-store");
  return c.json({ id: user.id, name: user.name, email: user.email } satisfies Me);
});
