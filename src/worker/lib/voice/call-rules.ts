/**
 * The pure rules for call rows: how a Twilio call event moves a row (see calls.ts for which SID a row is
 * keyed by). No database or bindings here, so the rules run in plain unit tests.
 */
import {
  type CallStatus,
  callStatusSchema,
  isTerminalCallStatus,
  type LivePush,
  nextCallStatus,
} from "../../../contracts";
import { isMissedCall } from "../../../contracts/contacts";
import { formatPhone, isE164 } from "../../../lib/phone";
import type { calls } from "../../db/schema/app";

export type CallRow = typeof calls.$inferSelect;
/**
 * Where an event came from. "child": a status callback of a dialed leg. "dial": the <Dial action> result
 * (DialCallStatus) or the catch-up's final answer, which speaks for the whole dial. "parent": a status
 * callback of the leg that owns the row.
 */
export type Leg = "parent" | "child" | "dial";

export type CallEvent = {
  leg: Leg;
  status: CallStatus;
  /** Seconds of talk time Twilio reported for this leg, when it did. */
  duration?: number | null;
  /** Twilio's ErrorCode and ErrorMessage when the dialed leg failed to connect. */
  errorCode?: number | null;
  errorMessage?: string | null;
  at: Date;
};

/** Twilio's CallStatus string, or null when it is not one we know. */
export const parseCallStatus = (v: unknown): CallStatus | null => {
  const r = callStatusSchema.safeParse(v);
  return r.success ? r.data : null;
};

/** DialCallStatus from a <Dial action> request. "answered" only appears there and means completed. */
export const parseDialStatus = (v: unknown): CallStatus | null =>
  v === "answered" ? "completed" : parseCallStatus(v);

/** Twilio's ErrorCode parameter: a positive integer, or null. */
export const parseErrorCode = (v: unknown): number | null => {
  const n = typeof v === "string" && /^\d{1,6}$/.test(v.trim()) ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Twilio's ErrorMessage parameter, trimmed and cut to a short line, or null. */
export const parseErrorMessage = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim().slice(0, 200) : "";
  return s || null;
};

/** The call statuses that can carry a reason for not connecting. */
const FAILURE_STATUSES = new Set<CallStatus>(["failed", "busy", "no-answer"]);

export const parseDuration = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Callers that hide their number arrive as these placeholders, never as E.164. */
export const isWithheld = (party: string) => !isE164(party);

/**
 * The fields to write when `event` arrives for `row`, or null when nothing changes. Pure, so ordering rules
 * are tested without a database.
 */
export function planCallUpdate(row: CallRow, event: CallEvent): Partial<CallRow> | null {
  let incoming: CallStatus = event.status;
  const inbound = row.direction === "inbound";
  if (event.leg === "parent") {
    if (!inbound || !isTerminalCallStatus(incoming)) return null;
    incoming = row.answeredAt ? "completed" : "no-answer";
  } else if (inbound && isTerminalCallStatus(incoming) && incoming !== "completed") {
    // An inbound call rings every registered device, and each ring can be its own child leg. The legs
    // nobody picked up end canceled or no-answer while another leg may be talking, so a child's
    // unanswered end never closes the row. The dial result (or the parent leg) does.
    if (event.leg === "child") return null;
    // The dial result after an answer: the call was taken, whatever the last ring reported.
    if (row.answeredAt) incoming = "completed";
  }
  const status = nextCallStatus(row.status, incoming);
  const patch: Partial<CallRow> = {};
  if (status !== row.status) patch.status = status;

  // "completed" from the dialed leg means it was answered; "in-progress" is the answer itself.
  const dialed = event.leg !== "parent";
  const answered = dialed && (incoming === "in-progress" || incoming === "completed");
  if (answered && !row.answeredAt && !isTerminalCallStatus(row.status)) {
    const talk = incoming === "completed" ? (event.duration ?? 0) : 0;
    patch.answeredAt = new Date(event.at.getTime() - talk * 1000);
  }
  if (isTerminalCallStatus(status) && !row.endedAt) {
    patch.endedAt = event.at;
    const answeredAt = patch.answeredAt ?? row.answeredAt;
    patch.duration = answeredAt
      ? ((dialed ? event.duration : null) ??
        Math.max(0, Math.round((event.at.getTime() - answeredAt.getTime()) / 1000)))
      : 0;
  }
  // Why an outbound dial did not connect. Kept once: the child leg and the dial result both carry it.
  if (
    !inbound &&
    event.leg !== "parent" &&
    event.errorCode &&
    !row.errorCode &&
    FAILURE_STATUSES.has(incoming) &&
    FAILURE_STATUSES.has(status)
  ) {
    patch.errorCode = event.errorCode;
    patch.errorMessage = event.errorMessage ?? null;
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * The outcome an inbound call gets when `patch` ends it: answered or missed, unless routing already set one
 * (voicemail, declined, blocked). Null when the patch does not end an inbound call without an outcome.
 */
export function outcomeOnEnd(row: CallRow, patch: Partial<CallRow>): CallRow["outcome"] {
  if (row.direction !== "inbound" || row.outcome || !patch.endedAt || row.endedAt) return null;
  return (patch.answeredAt ?? row.answeredAt) ? "answered" : "missed";
}

/** A missed call: inbound, ended, never answered, not sent to voicemail, declined or blocked. */
export const isMissed = (row: Pick<CallRow, "direction" | "status" | "answeredAt" | "outcome">) =>
  isMissedCall(row);

/** How a call party reads in a notification. */
export const partyLabel = (party: string, contactName?: string | null) =>
  contactName || (isE164(party) ? formatPhone(party) : "Withheld number");

/**
 * The web push for a call waiting to be answered. High urgency so a sleeping phone wakes, kept on screen,
 * tagged by call, held by the push service no longer than the call can ring. A tap opens the answer route.
 */
export const incomingCallPush = (
  row: Pick<CallRow, "id" | "party" | "twilioCallSid">,
  contactName: string | null,
  ringSeconds: number,
): LivePush => ({
  title: "Incoming call",
  body: partyLabel(row.party, contactName),
  url: `/answer/${row.id}`,
  tag: `call-${row.twilioCallSid}`,
  requireInteraction: true,
  urgency: "high",
  ttl: ringSeconds,
});

/** The web push for a missed call. Tagged by call, so a repeat replaces the notice instead of adding one. */
export const missedCallPush = (
  row: Pick<CallRow, "party" | "twilioCallSid">,
  contactName: string | null,
): LivePush => ({
  title: "Missed call",
  body: partyLabel(row.party, contactName),
  url: "/recents",
  tag: `missed-${row.twilioCallSid}`,
});
