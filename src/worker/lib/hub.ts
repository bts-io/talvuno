import { type LiveEvent, liveEventSchema } from "../../contracts";
import type { ConsumeKind, ConsumeResult } from "../durable/owner-hub";
import { sendPushToOwner } from "./push";

/** The owner's hub. One Durable Object per owner, addressed by the owner's user id. */
export function hubFor(env: Env, ownerId: string) {
  return env.OWNER_HUB.get(env.OWNER_HUB.idFromName(ownerId));
}

/**
 * Tells every open tab of `ownerId` that something changed. Call it after the D1 write commits. It never
 * throws: a failed broadcast must not fail a webhook, because clients refetch on reconnect anyway.
 *
 * When the event carries `push` and no tab was open to receive it, the owner's devices get a Web Push notice
 * instead. Pass `ctx` (for example `c.executionCtx`) to send it after the response; without it the push is
 * awaited. Either way it never throws. `opts.alwaysPush` sends the push even when a tab was open, for a
 * ringing call: an open tab on one device says nothing about the owner's phone in a pocket.
 */
export async function notifyOwner(
  env: Env,
  ownerId: string,
  event: LiveEvent,
  ctx?: Pick<ExecutionContext, "waitUntil">,
  opts: { alwaysPush?: boolean } = {},
): Promise<number> {
  let parsed: LiveEvent;
  let reached = 0;
  try {
    parsed = liveEventSchema.parse(event);
    reached = await hubFor(env, ownerId).notify(parsed);
  } catch (err) {
    console.error("live notify failed", { type: event?.type, error: String(err) });
    return reached;
  }
  if (parsed.push && (reached === 0 || opts.alwaysPush)) {
    const push = sendPushToOwner(env, ownerId, parsed.push);
    if (ctx) ctx.waitUntil(push);
    else await push;
  }
  return reached;
}

/**
 * Atomically takes one SMS or call from the owner's hourly budget. Check `allowed` before calling Twilio.
 * Unlike notify, this fails closed: if the hub cannot answer, the send is refused.
 */
export async function consume(
  env: Env,
  ownerId: string,
  kind: ConsumeKind,
  limit: number,
  windowSeconds = 3600,
): Promise<ConsumeResult> {
  return hubFor(env, ownerId).consume(kind, limit, windowSeconds);
}
