// A stand-in origin: only used to tell "stays on this site" from "goes elsewhere", never to build a link.
const BASE = "https://talvuno.invalid";
const FALLBACK = "/keypad";

/**
 * The post-login target from `?next=`, if it is a path on this site; otherwise `/keypad`.
 *
 * Browsers treat a backslash like a slash, so "/\evil.com" and "//evil.com" both mean another host. The check
 * parses the value against a base origin and requires the result to stay on it, and refuses backslashes and
 * control characters outright.
 */
export function safeNext(next: string | undefined): string {
  if (!next?.startsWith("/") || next.startsWith("//")) return FALLBACK;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is refused.
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return FALLBACK;
  let url: URL;
  try {
    url = new URL(next, BASE);
  } catch {
    return FALLBACK;
  }
  if (url.origin !== BASE) return FALLBACK;
  return `${url.pathname}${url.search}${url.hash}`;
}
