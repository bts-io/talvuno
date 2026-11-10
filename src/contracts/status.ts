import { z } from "zod";

/**
 * Twilio message and call statuses, and the ordering rules that keep stored status monotonic.
 *
 * Twilio retries webhooks and does not promise order, so a "sent" callback can arrive after "delivered".
 * Every write of a status goes through `nextMessageStatus` / `nextCallStatus`: a status only moves forward,
 * and once a terminal status is stored it stays (except a message moving from delivered to read).
 */

export const MESSAGE_STATUSES = [
  "accepted",
  "scheduled",
  "queued",
  "sending",
  "sent",
  "partially_delivered",
  "receiving",
  "received",
  "delivered",
  "undelivered",
  "failed",
  "canceled",
  "read",
] as const;
export const messageStatusSchema = z.enum(MESSAGE_STATUSES);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const CALL_STATUSES = [
  "queued",
  "initiated",
  "ringing",
  "in-progress",
  "completed",
  "busy",
  "no-answer",
  "failed",
  "canceled",
] as const;
export const callStatusSchema = z.enum(CALL_STATUSES);
export type CallStatus = z.infer<typeof callStatusSchema>;

/**
 * How an inbound call ended for the owner. Null while a call is live, and for outbound calls. "forwarded"
 * means a phone menu key sent the caller on to another number.
 */
export const CALL_OUTCOMES = ["answered", "missed", "voicemail", "declined", "blocked", "forwarded"] as const;
export const callOutcomeSchema = z.enum(CALL_OUTCOMES);
export type CallOutcome = z.infer<typeof callOutcomeSchema>;

const MESSAGE_RANK: Record<MessageStatus, number> = {
  accepted: 0,
  scheduled: 0,
  queued: 1,
  sending: 2,
  receiving: 2,
  sent: 3,
  // Some parts reached the handset, the rest are still outstanding: a final delivered or failed may follow.
  partially_delivered: 4,
  received: 5,
  delivered: 5,
  undelivered: 5,
  failed: 5,
  canceled: 5,
  read: 6,
};

const CALL_RANK: Record<CallStatus, number> = {
  queued: 0,
  initiated: 1,
  ringing: 2,
  "in-progress": 3,
  completed: 4,
  busy: 4,
  "no-answer": 4,
  failed: 4,
  canceled: 4,
};

const MESSAGE_TERMINAL = new Set<MessageStatus>([
  "received",
  "delivered",
  "undelivered",
  "failed",
  "canceled",
  "read",
]);
const CALL_TERMINAL = new Set<CallStatus>(["completed", "busy", "no-answer", "failed", "canceled"]);

export const isTerminalMessageStatus = (s: MessageStatus) => MESSAGE_TERMINAL.has(s);
export const isTerminalCallStatus = (s: CallStatus) => CALL_TERMINAL.has(s);

/** The status to store when `incoming` arrives while `current` is stored. Never moves backwards. */
export function nextMessageStatus(current: MessageStatus | null | undefined, incoming: MessageStatus) {
  if (!current) return incoming;
  // Only "read" may follow a terminal status, and only after a delivery.
  if (MESSAGE_TERMINAL.has(current)) return current === "delivered" && incoming === "read" ? "read" : current;
  return MESSAGE_RANK[incoming] > MESSAGE_RANK[current] ? incoming : current;
}

/** The status to store when `incoming` arrives while `current` is stored. Never moves backwards. */
export function nextCallStatus(current: CallStatus | null | undefined, incoming: CallStatus) {
  if (!current) return incoming;
  if (CALL_TERMINAL.has(current)) return current;
  return CALL_RANK[incoming] > CALL_RANK[current] ? incoming : current;
}
