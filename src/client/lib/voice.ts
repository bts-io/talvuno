/**
 * Plain helpers for calling: Twilio error codes turned into words, the call timer, keypad input. No SDK or
 * browser APIs here, so these run in SSR and unit tests.
 */

/**
 * The en.json key (under `voice.errors.`) for a Twilio Voice SDK error code. Codes from the SDK's error
 * list (errors/generated): token problems, microphone, network, and the far end refusing.
 *
 * An expired token ("token") is fixed by fetching a new one. A token Twilio refuses outright ("credentials":
 * bad signature, unknown API key or issuer, wrong grants) means this deployment's Twilio settings are wrong,
 * and a new token signed the same way fails the same way.
 */
export function voiceErrorKey(code: number | undefined): string {
  switch (code) {
    case 20104:
    case 31205:
      return "token";
    case 20101:
    case 20102:
    case 20103:
    case 20105:
    case 20106:
    case 20107:
    case 20151:
    case 20157:
    case 31202:
    case 31204:
    case 31207:
      return "credentials";
    case 31401:
      return "micDenied";
    case 31402:
      return "micUnavailable";
    case 31002:
    case 31486:
    case 31603:
      return "declined";
    case 31404:
    case 31480:
      return "unreachable";
    case 31003:
    case 31005:
    case 31009:
    case 53000:
    case 53001:
    case 53405:
      return "network";
    case 31001:
      return "notSetUp";
    case 31206:
      return "rateLimited";
    default:
      return "generic";
  }
}

/**
 * The en.json key (under `voice.errors.`) for the Twilio error code of a call that was placed but did not
 * connect. These come from the dial result, not the Voice SDK. 13227 and 21215 are Voice Geo Permissions
 * on the account (21215 is Twilio's code for a destination its geo permissions refuse). 13225 is Twilio
 * blocking the call itself, for fraud risk or regulation.
 */
export function callFailureKey(code: number): string {
  switch (code) {
    case 13227:
    case 21215:
      return "geoPermission";
    case 13225:
      return "callBlocked";
    case 13224:
      return "invalidNumber";
    case 13223:
      return "unknownNumberFormat";
    case 13214:
      return "callerIdNotOwned";
    default:
      return "callFailed";
  }
}

/**
 * Whether a live call-failure event belongs to the call this tab placed. The event carries the parent CallSid
 * and the SDK call knows its own; a tab that did not place the call, or does not know its sid yet, shows nothing.
 */
export function isOwnCallFailure(eventSid: string | undefined, ownSid: string | null | undefined): boolean {
  return Boolean(eventSid && ownSid && eventSid === ownSid);
}

/** Keys for a device error that never recovers on its own: calling goes off with a Retry. */
export function stopsCalling(key: string): boolean {
  return key === "token" || key === "credentials";
}

/** The message shown when getting a token or registering failed: token and credential problems by name. */
export function setupErrorKey(code: number | undefined): string {
  const key = voiceErrorKey(code);
  return stopsCalling(key) ? key : "setup";
}

/** The part of the SDK Device that registering needs, so the flow below runs in unit tests. */
export type RegisteringDevice = {
  on(event: "error", listener: (err: { code?: number } | undefined) => void): unknown;
  register(): Promise<void>;
};

/**
 * Registers the device and reports a failure that stops calling once, with the first error that caused it.
 * When Twilio refuses the token (20101 and the other credential codes) the SDK emits a Device `error` with the
 * code, then `register()` rejects without one. Reporting only the first keeps the credentials message instead
 * of the generic "could not connect" one. Errors that do not stop calling go to `onError`.
 */
export async function registerDevice(
  device: RegisteringDevice,
  onSetupFailed: (err: unknown) => void,
  onError: (err: { code?: number } | undefined) => void,
): Promise<void> {
  let reported = false;
  const failOnce = (err: unknown) => {
    if (reported) return;
    reported = true;
    onSetupFailed(err);
  };
  device.on("error", (err) => (stopsCalling(voiceErrorKey(err?.code)) ? failOnce(err) : onError(err)));
  try {
    await device.register();
  } catch (err) {
    failOnce(err);
  }
}

/**
 * What the phone does when getting a token or registering failed (the first time, or a token refresh): when
 * the owner's session has expired (401) only signing in again helps, so it goes to login; anything else
 * leaves calling off with a Retry that fetches a new token and registers again.
 */
export function deviceSetupFailure(err: unknown): "login" | "retry" {
  return (err as { status?: unknown } | null)?.status === 401 ? "login" : "retry";
}

/** A call timer, "m:ss" or "h:mm:ss". */
export function formatCallTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Characters a keypad accepts, also used to clean pasted text. */
export const DIAL_CHARS = /[0-9+*#]/g;

/** Keeps only dialable characters, and a single leading plus. */
export function cleanDialInput(input: string): string {
  const chars = (input.match(DIAL_CHARS) ?? []).join("");
  return chars.startsWith("+") ? `+${chars.slice(1).replace(/\+/g, "")}` : chars.replace(/\+/g, "");
}

/**
 * Wraps an async action so a second call while the first is still running does nothing (it resolves at once).
 * `onChange` hears when the action starts and stops, for a disabled button.
 */
export function singleFlight<A extends unknown[]>(
  action: (...args: A) => Promise<void>,
  onChange?: (busy: boolean) => void,
): (...args: A) => Promise<void> {
  let busy = false;
  return async (...args) => {
    if (busy) return;
    busy = true;
    onChange?.(true);
    try {
      await action(...args);
    } finally {
      busy = false;
      onChange?.(false);
    }
  };
}
