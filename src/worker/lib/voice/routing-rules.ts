/**
 * The pure inbound routing rules (see routing.ts for the flow). No database or bindings here, so the rules run
 * in plain unit tests.
 */
import { type BusinessHours, isOpenAt } from "../../../lib/business-hours";
import type { CallRow } from "./call-rules";

/** Seconds a claimed call still waits for its bridge after the ring time, so a late answer is not cut off. */
export const CLAIM_GRACE_SECONDS = 15;
/** One ringback cycle: the tone file plays this long, then a pause. */
export const RINGBACK_TONE_SECONDS = 2;
export const RINGBACK_PAUSE_SECONDS = 4;

export type InboundRoute = "reject" | "voicemail" | "queue";

/** Where an inbound call goes: blocked callers are rejected, DND and closed hours go to voicemail. */
export function decideInbound(input: {
  blocked: boolean;
  dnd: boolean;
  hours: BusinessHours | null;
  at: Date;
}): InboundRoute {
  if (input.blocked) return "reject";
  if (input.dnd || !isOpenAt(input.hours, input.at)) return "voicemail";
  return "queue";
}

/**
 * What the caller hears next while waiting: ringback, or leave the queue once the ring time is up, the owner
 * declined or the call is no longer waiting. A claimed call gets a short grace so the bridge can land.
 */
export function waitDecision(
  row: Pick<CallRow, "outcome" | "endedAt" | "declinedAt" | "answerCallSid"> | null,
  queueTime: number,
  ringSeconds: number,
): { leave: true } | { leave: false; pause: number } {
  if (!row || row.outcome || row.endedAt || row.declinedAt) return { leave: true };
  const limit = ringSeconds + (row.answerCallSid ? CLAIM_GRACE_SECONDS : 0);
  const left = limit - queueTime;
  if (left <= 0) return { leave: true };
  return { leave: false, pause: Math.max(1, Math.min(RINGBACK_PAUSE_SECONDS, left - RINGBACK_TONE_SECONDS)) };
}
