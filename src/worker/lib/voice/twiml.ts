/**
 * Tiny TwiML writer. Only the verbs Talvuno answers with: Dial (Number, Client), Say, Hangup, Reject. Every
 * attribute and text value is XML-escaped, so a caller-supplied value can never add markup.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};
export const xmlEscape = (s: string) => s.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);

type Attrs = Record<string, string | number | boolean | undefined>;

function attrs(a: Attrs): string {
  return Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${xmlEscape(String(v))}"`)
    .join("");
}

export const el = (name: string, a: Attrs = {}, children?: string) =>
  children === undefined ? `<${name}${attrs(a)}/>` : `<${name}${attrs(a)}>${children}</${name}>`;

export const text = (s: string) => xmlEscape(s);

export const response = (...verbs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response>${verbs.join("")}</Response>`;

/** The events every leg we dial reports to /status. */
export const STATUS_EVENTS = "initiated ringing answered completed";

/** A spoken refusal, then hang up. Never dials. */
export const sayAndHangUp = (message: string) => response(el("Say", {}, text(message)), el("Hangup"));

export const twimlResponse = (body: string) =>
  new Response(body, { headers: { "content-type": "text/xml; charset=utf-8" } });
