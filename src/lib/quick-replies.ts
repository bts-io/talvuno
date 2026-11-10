import type { SmsNumber } from "../contracts/messages";
import { isE164 } from "./phone";

/** What picking a quick reply does to the message box: fills it, or adds to what is already typed. Never sends. */
export function fillDraft(draft: string, reply: string): string {
  const typed = draft.trimEnd();
  return typed ? `${typed} ${reply}` : reply;
}

/**
 * The number a ringing call came in on, when "decline with text" can work: the caller is a full E.164
 * number (not withheld, not a short code) and the called number is one of ours that can send texts.
 */
export function declineTextNumber(
  incoming: { party: string; numberId: string | null } | null,
  numbers: SmsNumber[] | undefined,
): SmsNumber | null {
  if (!incoming?.numberId || !isE164(incoming.party)) return null;
  return numbers?.find((n) => n.id === incoming.numberId) ?? null;
}

export type DeclineTextResult = { ok: true } | { ok: false; error: unknown };

/**
 * Texts the caller first and declines only when the text was accepted. A refused text (country, rate limit,
 * Twilio) leaves the call ringing with the error on the sheet, so nothing is lost: the owner can still pick
 * up or decline plainly.
 */
export async function declineWithText(
  text: string,
  actions: { send: (text: string) => Promise<unknown>; decline: () => void },
): Promise<DeclineTextResult> {
  try {
    await actions.send(text);
  } catch (error) {
    return { ok: false, error };
  }
  actions.decline();
  return { ok: true };
}
