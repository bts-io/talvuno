/**
 * The pure phone menu rules (see menu.ts for the flow). No database or bindings here, so the rules run in
 * plain unit tests.
 */
import type { MenuDefaultAction, MenuKey } from "../../../contracts/menus";

/** Seconds Twilio waits for a key after the prompt ends. */
export const MENU_TIMEOUT_SECONDS = 6;
/** How many times the prompt plays before the default action. */
export const MENU_ATTEMPTS = 2;

export type MenuConfig = { prompt: string; keys: MenuKey[]; defaultAction: MenuDefaultAction };

export type MenuChoice =
  | { kind: "repeat"; attempt: number }
  | { kind: "ring" }
  | { kind: "voicemail" }
  | { kind: "forward"; to: string };

/** The attempt number from the action URL: 1 unless it says 2. Anything else reads as the last attempt. */
export function parseAttempt(v: string | undefined): number {
  if (v === undefined || v === "1") return 1;
  return MENU_ATTEMPTS;
}

/**
 * What a key press does. A key the menu has runs its action. No key, or one the menu does not have, plays the
 * prompt again on the first attempt and takes the default action after that.
 */
export function decideMenuChoice(menu: MenuConfig, digits: string | undefined, attempt: number): MenuChoice {
  const key = digits ? menu.keys.find((k) => k.digit === digits) : undefined;
  if (key) return key.action === "forward" ? { kind: "forward", to: key.to } : { kind: key.action };
  if (attempt < MENU_ATTEMPTS) return { kind: "repeat", attempt: attempt + 1 };
  return { kind: menu.defaultAction };
}
