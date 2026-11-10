/** Hold, resume, transfer and hang-up of the call in progress. The Worker finds the call by this browser's CallSid. */
import type { CallControlResult } from "../../contracts/call-control";
import { ApiError, api } from "./api";

export type CallControlAction = "hold" | "resume" | "transfer" | "hangup";

export const callControl = (callSid: string, action: CallControlAction, to?: string) =>
  api<CallControlResult>(`/api/calls/${encodeURIComponent(callSid)}/${action}`, {
    method: "POST",
    json: action === "transfer" ? { to } : {},
  });

/** The voice.control.errors key for a failed hold, resume or transfer. */
export function callControlErrorKey(err: unknown): string {
  const code = err instanceof ApiError ? err.code : "";
  switch (code) {
    case "not_live":
    case "owner_leg_ended":
      return "notLive";
    case "invalid_number":
    case "invalid":
      return "invalidNumber";
    case "own_number":
      return "ownNumber";
    case "country_not_allowed":
      return "countryNotAllowed";
    case "premium_rate":
      return "premiumRate";
    case "rate_limited":
      return "rateLimited";
    case "already_transferred":
      return "alreadyTransferred";
    default:
      return "generic";
  }
}
