/** Web Push contracts. Imported directly (not re-exported from index) by the push route and the Settings UI. */
import { z } from "zod";

const base64url = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+={0,2}$/, { message: "Expected base64url" });

/** What `PushSubscription.toJSON()` gives the browser. Endpoints are always https (RFC 8030). */
export const pushSubscriptionInputSchema = z.object({
  endpoint: z
    .url()
    .max(2048)
    .refine((u) => u.startsWith("https://"), { message: "Push endpoints are https" }),
  keys: z.object({ p256dh: base64url, auth: base64url }),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionInputSchema>;

export const pushUnsubscribeInputSchema = z.object({ endpoint: z.url().max(2048) });

export const vapidPublicKeySchema = z.object({ publicKey: z.string().nullable() });
export type VapidPublicKey = z.infer<typeof vapidPublicKeySchema>;
