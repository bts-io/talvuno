/**
 * Waiting inbound calls in the browser, the pure part: the list of waiting calls, the live event fan-out, the
 * answer parameters and the ringtone cadence. No DOM here, so it runs in plain unit tests. See incoming.ts.
 */
import type { LiveEvent } from "../../contracts";
import type { IncomingCallInfo } from "../../contracts/routing";

export type IncomingEvent = Extract<LiveEvent, { type: "incoming" }>;

/** The waiting calls after a live event: ringing adds or refreshes one, ended removes it. */
export function applyIncomingEvent(list: IncomingCallInfo[], event: IncomingEvent, now = Date.now()) {
  const rest = list.filter((c) => c.callId !== event.callId);
  if (event.state === "ended") return rest;
  return [
    {
      callId: event.callId,
      party: event.party ?? "",
      contactName: event.contactName ?? null,
      numberId: event.numberId ?? null,
      startedAt: now,
    },
    ...rest,
  ];
}

/** The call the incoming sheet shows: the newest still waiting. */
export const ringingCall = (list: IncomingCallInfo[]) => list[0] ?? null;

const listeners = new Set<(event: IncomingEvent) => void>();

/** Calls `listener` for every live incoming event. Returns the unsubscribe. */
export function onIncoming(listener: (event: IncomingEvent) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function announceIncoming(event: LiveEvent): void {
  if (event.type !== "incoming") return;
  for (const listener of listeners) listener(event);
}

/** The parameters a device sends to answer a waiting call instead of dialing. */
export const answerParams = (callId: string) => ({ AnswerCallId: callId });

/** One ringtone cycle in seconds: [tone on, silence] pairs, as a phone rings (two short rings, a pause). */
export const RING_PATTERN: readonly [number, number][] = [
  [0.4, 0.2],
  [0.4, 2.0],
];
export const RING_CYCLE_SECONDS = RING_PATTERN.reduce((s, [on, off]) => s + on + off, 0);

/** Start and stop times (seconds from `start`) of every tone in `cycles` ring cycles. */
export function ringSchedule(start: number, cycles: number): { on: number; off: number }[] {
  const out: { on: number; off: number }[] = [];
  let t = start;
  for (let i = 0; i < cycles; i++)
    for (const [on, off] of RING_PATTERN) {
      out.push({ on: t, off: t + on });
      t += on + off;
    }
  return out;
}
