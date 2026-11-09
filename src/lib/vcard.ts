/**
 * vCard 3.0 / 4.0 reading and writing for contacts. Pure functions shared by the Worker and the tests.
 * Reads FN, N, ORG, NOTE and TEL; every other property is ignored. Quoted-printable values (vCard 2.1 as
 * written by Android) are decoded; base64 values are left out. A card that has no usable name or no valid
 * phone number is skipped and counted, never an error.
 */
import { type CountryCode, toE164 } from "./phone";

export type VcardNumber = { number: string; label: string | null };
export type VcardContact = {
  displayName: string;
  company: string | null;
  notes: string | null;
  numbers: VcardNumber[];
};
export type VcardParseResult = { contacts: VcardContact[]; skipped: number };

const NAME_MAX = 200;
const NOTES_MAX = 4000;
const NUMBERS_MAX = 20;

const unfold = (text: string) => text.replace(/\r\n|\r/g, "\n").replace(/\n[ \t]/g, "");

/** Splits on `sep` where it is not escaped with a backslash. */
function splitUnescaped(value: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (ch === "\\" && i + 1 < value.length) {
      cur += ch + value[++i];
    } else if (ch === sep) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

const unescapeText = (value: string) =>
  value.replace(/\\([nN,;\\])/g, (_m, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));

type Prop = { name: string; params: Map<string, string[]>; value: string };

function parseLine(line: string): Prop | null {
  // The name and parameters end at the first colon outside double quotes.
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon < 1) return null;
  const head = splitUnescaped(line.slice(0, colon), ";");
  const rawName = (head[0] ?? "").trim();
  const name = (rawName.includes(".") ? rawName.slice(rawName.lastIndexOf(".") + 1) : rawName).toUpperCase();
  if (!name) return null;
  const params = new Map<string, string[]>();
  for (const p of head.slice(1)) {
    const eq = p.indexOf("=");
    // vCard 2.1 and some 3.0 writers use bare type words: TEL;CELL;VOICE.
    const key = (eq < 0 ? "TYPE" : p.slice(0, eq)).trim().toUpperCase();
    const raw = eq < 0 ? p : p.slice(eq + 1);
    const values = raw
      .split(",")
      .map((v) => v.trim().replace(/^"|"$/g, "").toLowerCase())
      .filter(Boolean);
    params.set(key, [...(params.get(key) ?? []), ...values]);
  }
  return { name, params, value: line.slice(colon + 1) };
}

const LABELS: Record<string, string> = {
  cell: "mobile",
  mobile: "mobile",
  iphone: "mobile",
  home: "home",
  work: "work",
  main: "main",
  fax: "fax",
  other: "other",
};

function labelFor(params: Map<string, string[]>): string | null {
  for (const type of params.get("TYPE") ?? []) {
    const mapped = LABELS[type];
    if (mapped) return mapped;
  }
  return null;
}

const clip = (s: string, max: number) => s.trim().slice(0, max);

function decodeUriSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const isQuotedPrintable = (prop: Prop) =>
  (prop.params.get("ENCODING") ?? []).some((e) => e.includes("quoted"));

/** Base64 values are not decoded, so those properties are left out. */
function isBase64(prop: Prop): boolean {
  return (prop.params.get("ENCODING") ?? []).some((e) => e === "b" || e === "base64");
}

/** Decodes a quoted-printable value: `=XX` bytes read in the CHARSET parameter (UTF-8 by default). */
export function decodeQuotedPrintable(value: string, charset = "utf-8"): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    const hex = ch === "=" ? value.slice(i + 1, i + 3) : "";
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      // A literal character (or a stray "="): keep it as its own UTF-8 bytes.
      const code = value.codePointAt(i) as number;
      const lit = String.fromCodePoint(code);
      bytes.push(...encoder.encode(lit));
      if (code > 0xffff) i++;
    }
  }
  const raw = Uint8Array.from(bytes);
  try {
    return new TextDecoder(charset).decode(raw);
  } catch {
    return new TextDecoder().decode(raw);
  }
}

function cardFrom(props: Prop[], defaultCountry?: CountryCode): VcardContact | null {
  let fn = "";
  let n = "";
  let org = "";
  let notes = "";
  const numbers: VcardNumber[] = [];
  const seen = new Set<string>();
  for (const prop of props) {
    if (isBase64(prop)) continue;
    const qp = isQuotedPrintable(prop);
    const charset = prop.params.get("CHARSET")?.[0];
    const decode = (v: string) => (qp ? decodeQuotedPrintable(v, charset) : unescapeText(v));
    switch (prop.name) {
      case "FN":
        if (!fn) fn = decode(prop.value).trim();
        break;
      case "N": {
        if (n) break;
        const [family = "", given = "", additional = "", prefix = "", suffix = ""] = (
          qp ? prop.value.split(";") : splitUnescaped(prop.value, ";")
        ).map(decode);
        n = [prefix, given, additional, family, suffix]
          .map((s) => s.trim())
          .filter(Boolean)
          .join(" ");
        break;
      }
      case "ORG":
        if (!org)
          org = decode((qp ? prop.value.split(";") : splitUnescaped(prop.value, ";"))[0] ?? "").trim();
        break;
      case "NOTE":
        if (!notes) notes = decode(prop.value).trim();
        break;
      case "TEL": {
        if (numbers.length >= NUMBERS_MAX) break;
        const raw = (
          (qp ? decode(prop.value) : prop.value).trim().replace(/^tel:/i, "").split(";")[0] ?? ""
        ).trim();
        const e164 = toE164(decodeUriSafe(raw), defaultCountry);
        if (!e164 || seen.has(e164)) break;
        seen.add(e164);
        numbers.push({ number: e164, label: labelFor(prop.params) });
        break;
      }
    }
  }
  const displayName = clip(fn || n || org, NAME_MAX);
  if (!displayName || numbers.length === 0) return null;
  return {
    displayName,
    company: org ? clip(org, NAME_MAX) : null,
    notes: notes ? clip(notes, NOTES_MAX) : null,
    numbers,
  };
}

/** Joins quoted-printable soft line breaks: a line that ends in "=" continues on the next line. */
function* logicalLines(text: string): Generator<string> {
  const lines = unfold(text.replace(/^\uFEFF/, "")).split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] as string;
    if (/quoted-printable/i.test(line.slice(0, line.indexOf(":") >>> 0))) {
      while (line.endsWith("=") && i + 1 < lines.length) line = line.slice(0, -1) + (lines[++i] as string);
    }
    yield line;
  }
}

/**
 * Parses a .vcf file's text. National numbers need `defaultCountry`; without it they are dropped. Parsing stops
 * once `maxCards` cards are read; the cards after that are only counted, as skipped.
 */
export function parseVcf(
  text: string,
  defaultCountry?: CountryCode,
  maxCards = Number.POSITIVE_INFINITY,
): VcardParseResult {
  const contacts: VcardContact[] = [];
  let skipped = 0;
  let current: Prop[] | null = null;
  for (const line of logicalLines(text)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const upper = trimmed.toUpperCase();
    if (contacts.length >= maxCards) {
      if (upper === "BEGIN:VCARD") skipped++;
      continue;
    }
    if (upper === "BEGIN:VCARD") {
      // A BEGIN inside an open card means the previous card never closed.
      if (current) skipped++;
      current = [];
    } else if (upper === "END:VCARD") {
      if (current) {
        const card = cardFrom(current, defaultCountry);
        if (card) contacts.push(card);
        else skipped++;
      }
      current = null;
    } else if (current) {
      const prop = parseLine(line);
      if (prop) current.push(prop);
    }
  }
  if (current) skipped++;
  return { contacts, skipped };
}

const escapeText = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");

const encoder = new TextEncoder();

/** Folds a line to 75 octets without splitting a character (RFC 6350 section 3.2). */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += size;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const TYPE_FOR_LABEL: Record<string, string> = { mobile: "CELL", home: "HOME", work: "WORK", fax: "FAX" };

function typeFor(label: string | null): string {
  if (!label) return "";
  return TYPE_FOR_LABEL[label] ?? (/^[A-Za-z0-9-]+$/.test(label) ? label.toUpperCase() : "");
}

/** Writes contacts as one vCard 3.0 file. */
export function serializeVcf(contacts: readonly VcardContact[]): string {
  const lines: string[] = [];
  for (const c of contacts) {
    lines.push("BEGIN:VCARD", "VERSION:3.0", `FN:${escapeText(c.displayName)}`);
    lines.push(`N:${escapeText(c.displayName)};;;;`);
    if (c.company) lines.push(`ORG:${escapeText(c.company)}`);
    for (const n of c.numbers) {
      const type = typeFor(n.label);
      lines.push(`TEL${type ? `;TYPE=${type}` : ""}:${n.number}`);
    }
    if (c.notes) lines.push(`NOTE:${escapeText(c.notes)}`);
    lines.push("END:VCARD");
  }
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
