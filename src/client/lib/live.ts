import type { QueryKey } from "@tanstack/react-query";
import { type LiveEvent, liveEventSchema } from "../../contracts";

/**
 * Query key roots. Features key their queries under these so live events refresh them:
 *   ["conversations", ...], ["messages", conversationId, ...], ["calls", ...]
 */
export const queryKeys = {
  conversations: ["conversations"] as const,
  messages: (conversationId: string) => ["messages", conversationId] as const,
  calls: ["calls"] as const,
};

/** Which queries a live event makes stale. */
export function keysForEvent(event: LiveEvent): QueryKey[] {
  switch (event.type) {
    case "message":
      return [queryKeys.messages(event.conversationId), queryKeys.conversations];
    case "conversation":
      return [queryKeys.conversations];
    case "call":
    case "incoming":
      return [queryKeys.calls];
  }
}

type CallEvent = Extract<LiveEvent, { type: "call" }>;
const failureListeners = new Set<(event: CallEvent) => void>();

/** Calls `listener` for every live call event that carries a Twilio error code. Returns the unsubscribe. */
export function onCallFailure(listener: (event: CallEvent) => void): () => void {
  failureListeners.add(listener);
  return () => void failureListeners.delete(listener);
}

/** Tells the call failure listeners about `event`, when it is a call event with an error code. */
export function announceCallFailure(event: LiveEvent): void {
  if (event.type !== "call" || !event.errorCode) return;
  for (const listener of failureListeners) listener(event);
}

/** Parses one socket frame. Anything that is not a known event (hello, pong, garbage) is null. */
export function parseLiveFrame(data: unknown): LiveEvent | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = liveEventSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Reconnect delay: exponential from 1 s, capped at 30 s, with up to 30% jitter so tabs do not stampede. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.7 + 0.3 * random()));
}
