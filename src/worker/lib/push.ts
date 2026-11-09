/**
 * Web Push from the Worker. The payload is encrypted per RFC 8291 (aes128gcm) and authorised with a VAPID
 * JWT per RFC 8292, both through Web Crypto, by @block65/webcrypto-web-push (MIT, one small dependency, built
 * for Workers). We only decide who gets what and clean up dead subscriptions.
 */
import { buildPushPayload } from "@block65/webcrypto-web-push";
import { and, eq } from "drizzle-orm";
import { createDb, schema } from "../db";

export type PushPayload = { title: string; body: string; url: string; tag?: string };

export type PushResult = { sent: number; removed: number; failed: number };

type Vapid = { subject: string; publicKey: string; privateKey: string };

/** VAPID keys from the environment, or null when push is not configured on this deployment. */
export function vapidFromEnv(env: Env): Vapid | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return null;
  return { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
}

/** Most push services cap a payload near 4 KB; stay under 3000 bytes of UTF-8 to leave room. */
export const MAX_PAYLOAD_BYTES = 3000;

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

const withEllipsis = (chars: string[], keep: number) => `${chars.slice(0, keep).join("")}\u2026`;

/** Largest number of characters of `text` (plus an ellipsis) for which `fits` still holds. */
function longestFit(text: string, fits: (candidate: string) => boolean): string {
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(withEllipsis(chars, mid))) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 && !fits(withEllipsis(chars, 0)) ? "" : withEllipsis(chars, lo);
}

/** Shortens the body first, then the title, until the serialized payload is under the byte limit. */
export function fitPayload(payload: PushPayload, limit = MAX_PAYLOAD_BYTES): PushPayload {
  if (byteLength(payload) <= limit) return payload;
  const body = longestFit(payload.body, (b) => byteLength({ ...payload, body: b }) < limit);
  const fitted = { ...payload, body };
  if (byteLength(fitted) < limit) return fitted;
  const title = longestFit(payload.title, (t) => byteLength({ ...fitted, title: t }) < limit);
  return { ...fitted, title };
}

/** How long a push service may hold a notice for a device that is offline: a day. */
const TTL_SECONDS = 24 * 60 * 60;

/**
 * Sends `payload` to every device the owner has subscribed. Subscriptions the push service reports gone
 * (404 or 410) are deleted. Never throws: a failed push must not fail the webhook that caused it.
 */
export async function sendPushToOwner(env: Env, ownerId: string, payload: PushPayload): Promise<PushResult> {
  const result: PushResult = { sent: 0, removed: 0, failed: 0 };
  try {
    const vapid = vapidFromEnv(env);
    if (!vapid) return result;
    const db = createDb(env.DB);
    const subs = await db
      .select()
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.ownerId, ownerId));
    await Promise.all(
      subs.map(async (sub) => {
        try {
          const request = await buildPushPayload(
            { data: fitPayload(payload), options: { ttl: TTL_SECONDS, urgency: "normal" } },
            { endpoint: sub.endpoint, expirationTime: null, keys: { auth: sub.auth, p256dh: sub.p256dh } },
            vapid,
          );
          const res = await fetch(sub.endpoint, request);
          await res.body?.cancel();
          if (res.status === 404 || res.status === 410) {
            await db
              .delete(schema.pushSubscriptions)
              .where(
                and(eq(schema.pushSubscriptions.id, sub.id), eq(schema.pushSubscriptions.ownerId, ownerId)),
              );
            result.removed++;
          } else if (res.ok) {
            await db
              .update(schema.pushSubscriptions)
              .set({ lastUsedAt: new Date() })
              .where(eq(schema.pushSubscriptions.id, sub.id));
            result.sent++;
          } else {
            console.error("push rejected", { status: res.status, host: new URL(sub.endpoint).host });
            result.failed++;
          }
        } catch (err) {
          console.error("push failed", { error: String(err) });
          result.failed++;
        }
      }),
    );
  } catch (err) {
    console.error("push failed", { error: String(err) });
  }
  return result;
}
