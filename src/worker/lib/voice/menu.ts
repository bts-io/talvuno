/**
 * The phone menu of a number. It sits after the block, hours and do not disturb checks and before the queue:
 *
 *   /inbound            menu on: the prompt in a <Gather> for one key (attempt 1)
 *   /menu-choice        the key: ring (the normal queue), voicemail, or forward to a number the owner typed.
 *                       No key or an unknown key plays the prompt once more (attempt 2), then the default.
 *   /menu-forward-done  the forward's <Dial action>: answered ends the call, anything else goes to voicemail
 *
 * A forward is checked with assertCanContact when the menu is saved and again when the caller presses the
 * key, dials from the number that was called, and is recorded on the caller's own call row (outcome
 * "forwarded"), its leg reporting to /status like any dialed leg.
 */
import { and, eq } from "drizzle-orm";
import { menuKeysSchema, type NumberMenu } from "../../../contracts/menus";
import en from "../../../shared/locales/en.json";
import type { Db } from "../../db";
import { schema } from "../../db";
import { MENU_TIMEOUT_SECONDS, type MenuConfig } from "./menu-rules";
import { el, response, STATUS_EVENTS, text } from "./twiml";

export * from "./menu-rules";

/** Said before the voicemail greeting when a forward is refused at call time. */
export const FORWARD_REFUSED = en.routing.menu.forwardRefused;

const voiceUrl = (env: Env, path: string) => `${new URL(env.PUBLIC_URL).origin}/api/twilio/voice${path}`;

/** The stored menu of a number, or the empty default (off). Keys that no longer parse read as none. */
export async function numberMenu(db: Db, ownerId: string, numberId: string): Promise<NumberMenu> {
  const row = await db
    .select()
    .from(schema.numberMenus)
    .where(and(eq(schema.numberMenus.ownerId, ownerId), eq(schema.numberMenus.numberId, numberId)))
    .get();
  const keys = menuKeysSchema.safeParse(row?.keys ?? []);
  return {
    numberId,
    enabled: row?.enabled ?? false,
    prompt: row?.prompt ?? "",
    keys: keys.success ? keys.data : [],
    defaultAction: row?.defaultAction ?? "ring",
  };
}

/** The menu to play for a call to this number, or null when it is off, empty or unreadable. */
export async function activeMenu(
  db: Db,
  ownerId: string,
  numberId: string | null,
): Promise<MenuConfig | null> {
  if (!numberId) return null;
  const menu = await numberMenu(db, ownerId, numberId);
  return menu.enabled && menu.prompt.trim() && menu.keys.length ? menu : null;
}

/**
 * The prompt inside a <Gather> for one key. With actionOnEmptyResult Twilio posts to the action on a timeout
 * too, so the next step is decided in one place.
 */
export function menuTwiml(env: Env, prompt: string, attempt: number): string {
  return response(
    el(
      "Gather",
      {
        input: "dtmf",
        numDigits: 1,
        timeout: MENU_TIMEOUT_SECONDS,
        action: voiceUrl(env, `/menu-choice?attempt=${attempt}`),
        method: "POST",
        actionOnEmptyResult: true,
      },
      el("Say", {}, text(prompt.trim())),
    ),
  );
}

/** Forwards the caller from the number they called, with the dialed leg reporting to /status. */
export function forwardTwiml(env: Env, callerId: string, to: string, timeLimit: number): string {
  return response(
    el(
      "Dial",
      {
        callerId,
        timeLimit,
        action: voiceUrl(env, "/menu-forward-done"),
        method: "POST",
      },
      el(
        "Number",
        {
          statusCallback: voiceUrl(env, "/status"),
          statusCallbackEvent: STATUS_EVENTS,
          statusCallbackMethod: "POST",
        },
        text(to),
      ),
    ),
  );
}

/** Puts a spoken line in front of a TwiML document (used before the voicemail greeting). */
export function withNotice(twiml: string, message: string): string {
  return twiml.replace("<Response>", `<Response>${el("Say", {}, text(message))}`);
}
