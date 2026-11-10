/**
 * The prompt, schema and checks for transcript summaries. Pure: no bindings, no database, so the same code runs
 * in the Worker, in unit tests and in a script against the real model.
 */
import { z } from "zod";

export type SummaryKind = "voicemail" | "call";

/** Workers AI model for summaries: cheap, current and supports a JSON schema response format. */
export const SUMMARY_MODEL = "@cf/google/gemma-4-26b-a4b-it";

/** What a transcript without a real message gets, without asking the model. */
export const NO_MESSAGE = "No message";

/** The longest transcript sent, in characters. A ten-minute call is about 9,000. */
export const MAX_TRANSCRIPT_CHARS = 16_000;
export const MAX_SUMMARY_SENTENCES = 2;
export const MAX_ONE_LINER_WORDS = 12;
export const MAX_ACTION_ITEMS = 3;
/** The length the prompt asks for. The gate allows MAX_ACTION_ITEM_WORDS, so an item a little over still counts. */
export const ACTION_ITEM_PROMPT_WORDS = 12;
/** The longest action item kept. */
export const MAX_ACTION_ITEM_WORDS = 16;

export type SummaryResult = {
  summary: string;
  actionItems: string[];
  oneLiner: string | null;
};

const SYSTEM = [
  "You summarise phone transcripts for the person who owns the phone number. Address that person as you.",
  "Use only facts that are in the transcript. Never add names, numbers, dates, times, places or amounts that are not in it, and never work one out from another.",
  "Copy any phone number, extension, order number, amount, date or time exactly as it appears.",
  "Write every number the way the transcript writes it: digits stay digits and words stay words, so four days stays four days and 3 pm stays 3 pm.",
  "Keep every request, demand and deadline the caller gave, such as a refund or a date to reply by.",
  "Keep the details someone needs to act: what is wanted, where to go, when, and any number. Leave out background and small talk.",
  "Do not call an order, account, booking or parcel yours unless the transcript says it is.",
  "Do not give advice or opinions, and do not judge the caller's mood beyond what they said.",
  "Write plain English in short, simple sentences, even when the caller speaks another language.",
  "Do not use dashes as punctuation. Use commas or full stops instead.",
  "Refer to the other person by the name they gave, or as the caller when they gave none.",
  `If the transcript holds no real message (silence, noise, a few stray words), every text field is exactly "${NO_MESSAGE}" and there are no action items.`,
].join("\n");

const FIELDS: Record<SummaryKind, string> = {
  voicemail: [
    "This is a voicemail left for you.",
    "summary: one or two sentences on who called, what they want, and the place and time they gave. Conditions and threats go here, not in actionItems.",
    `actionItems: up to three things the caller asked or told you to do, each at most ${ACTION_ITEM_PROMPT_WORDS} words, such as call back, collect, pay or send. Keep the place, time and number that go with each item in that item. Never an item that starts with if. Leave it empty when they asked for nothing.`,
    `oneLiner: why they called, at most ${MAX_ONE_LINER_WORDS} words, no full stop. Start with their name or organisation when they gave one, for example: Name wants a call back about the invoice`,
  ].join("\n"),
  call: [
    "This is a recorded call between you and another person.",
    "summary: one or two sentences on what was discussed and agreed.",
    `actionItems: up to three follow ups either side agreed to, each at most ${ACTION_ITEM_PROMPT_WORDS} words, saying who does it. Leave it empty when nothing was agreed.`,
  ].join("\n"),
};

/** The JSON schema the model must answer with. */
export function summarySchema(kind: SummaryKind) {
  const properties: Record<string, unknown> = {
    summary: { type: "string" },
    actionItems: { type: "array", items: { type: "string" }, maxItems: MAX_ACTION_ITEMS },
  };
  if (kind === "voicemail") properties.oneLiner = { type: "string" };
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/** Strips bracketed tags such as [inaudible] and counts the words left. */
const realWords = (text: string) =>
  text
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .split(/\s+/)
    .filter((w) => /\p{L}{2,}|\d/u.test(w)).length;

/** Fewer real words than this is noise, not a message. */
export const MIN_MESSAGE_WORDS = 3;

export const isNoMessage = (transcript: string) => realWords(transcript) < MIN_MESSAGE_WORDS;

/** The summary for a transcript without a message. */
export const emptySummary = (kind: SummaryKind): SummaryResult => ({
  summary: NO_MESSAGE,
  actionItems: [],
  oneLiner: kind === "voicemail" ? NO_MESSAGE : null,
});

/** The Workers AI input for a transcript, or null when there is nothing to summarise. */
export function summaryInput(kind: SummaryKind, transcript: string) {
  const text = transcript.trim();
  if (isNoMessage(text)) return null;
  return {
    messages: [
      { role: "system", content: `${SYSTEM}\n\n${FIELDS[kind]}` },
      { role: "user", content: `Transcript:\n"""\n${text.slice(0, MAX_TRANSCRIPT_CHARS)}\n"""` },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "summary", schema: summarySchema(kind), strict: true },
    },
    // A summary needs no reasoning pass: it is slower, costs more and can use up the token budget.
    chat_template_kwargs: { enable_thinking: false },
    max_tokens: 400,
    temperature: 0.1,
  };
}

// Built from escapes so this file stays free of the characters it removes.
// biome-ignore lint/complexity/useRegexLiterals: a literal would be rewritten to the raw characters
const DASH_RANGE = new RegExp("(\\d)\\s*[\\u2013\\u2014]\\s*(\\d)", "g");
// biome-ignore lint/complexity/useRegexLiterals: a literal would be rewritten to the raw characters
const DASH = new RegExp("\\s*[\\u2013\\u2014]\\s*", "g");

/** Replaces em and en dashes: a range between digits reads "to", anything else becomes a comma. */
export const noDashes = (text: string) =>
  text
    .replace(DASH_RANGE, "$1 to $2")
    .replace(DASH, ", ")
    .replace(/,\s*([,.])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();

/** An action item that hangs on a condition ("refund if no reply") is a threat, not a task: it is dropped. */
const CONDITIONAL = /\b(if|unless|otherwise)\b/i;

/** Words a full stop can follow without ending the sentence, compared lower case and without the last dot. */
const NO_BREAK_AFTER = new Set([
  "dr",
  "mr",
  "mrs",
  "ms",
  "mx",
  "st",
  "mt",
  "jr",
  "sr",
  "prof",
  "rev",
  "capt",
  "sgt",
  "e.g",
  "i.e",
  "etc",
  "vs",
  "approx",
  "a.m",
  "p.m",
  "ave",
  "rd",
]);

/** Sentence ends: punctuation, any closing quote or bracket, then a space or the end of the text. */
const SENTENCE_END = /[.!?]+["')\]]*(?=\s|$)/g;

/**
 * Splits text into sentences without breaking figures or names. A full stop only ends a sentence when a
 * space or the end of the text follows it, so "$1,250.75", "3.30pm", "12.5", an email or a URL stay whole.
 * A single full stop after a title or abbreviation (Dr, Mr, St, e.g., etc.) or an initial does not end one.
 */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of text.matchAll(SENTENCE_END)) {
    const end = m.index + m[0].length;
    if (m[0] === ".") {
      const word = (text.slice(start, m.index).match(/(\S+)$/)?.[1] ?? "").replace(/^[("'[]+/, "");
      if (NO_BREAK_AFTER.has(word.toLowerCase()) || /^\p{Lu}$/u.test(word)) continue;
    }
    const sentence = text.slice(start, end).trim();
    if (sentence) out.push(sentence);
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

/** What may sit between the digit groups of one figure: "0412 345 678", "$1,250.75", "3:30", "(02) 9555". */
const FIGURE = /\d+(?:[\s.,:/()-]{1,2}\d+)*/g;
/** What may sit between two digit groups of the transcript that together make one figure. */
const FIGURE_JOIN = /^[\s.,:/()-]{1,3}$/;
/** A separator inside one figure, as in "4,500", "1,250.75" or "3:30". A run of groups may not stop at one. */
const INSIDE_FIGURE = /^[.,:/]+$/;

/** Every figure in text, as its digits only. */
export const figures = (text: string) => [...text.matchAll(FIGURE)].map((m) => m[0].replace(/\D/g, ""));

/**
 * A check that every figure in a piece of output is in the transcript. Only digits are compared, so spacing
 * and punctuation may differ: "0412 345 678" matches "0412345678" and the other way round. A figure matches
 * one digit group of the transcript, or several in a row with only spaces or punctuation between them, and
 * always whole groups, so "12" does not match "1,250" and "450" does not match "4,500". A part of a figure
 * only matches where the separator has a space, a bracket or a hyphen, as in a phone number: "9555 0142" is
 * in "(02) 9555-0142", but "500" is not in "4,500", "1,250" is not in "1,250.75" and "30" is not in "3:30".
 */
export function figureCheck(transcript: string): (output: string) => boolean {
  const groups = [...transcript.matchAll(/\d+/g)];
  /** The text between group i and the next one. */
  const after = (i: number) => {
    const group = groups[i]!;
    const next = groups[i + 1];
    return next ? transcript.slice(group.index + group[0].length, next.index) : "";
  };
  const known = new Set<string>();
  for (let i = 0; i < groups.length; i++) {
    if (i > 0 && INSIDE_FIGURE.test(after(i - 1))) continue;
    let digits = "";
    for (let j = i; j < groups.length; j++) {
      digits += groups[j]![0];
      if (!INSIDE_FIGURE.test(after(j))) known.add(digits);
      if (!FIGURE_JOIN.test(after(j))) break;
    }
  }
  return (output) => figures(output).every((f) => known.has(f));
}
const words = (text: string) => text.split(/\s+/).filter(Boolean);

const clean = (s: string) => noDashes(s).replace(/^["']|["']$/g, "");

const text = z.string().trim().min(1).max(600).transform(clean);

const modelReply = z.object({
  summary: text,
  actionItems: z.array(z.string().trim().max(200).transform(clean)).max(MAX_ACTION_ITEMS).default([]),
  oneLiner: text.optional(),
});

type ModelOut = { response?: unknown; choices?: { message?: { content?: unknown } }[] };

/**
 * The JSON object in a model reply. Chat models answer in the OpenAI shape (`choices[0].message.content`),
 * older ones under `response`. Either may be a parsed object or a string holding JSON.
 */
function replyObject(out: unknown): unknown {
  const o = (out && typeof out === "object" ? out : {}) as ModelOut;
  const value = o.choices ? o.choices[0]?.message?.content : "response" in o ? o.response : out;
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

/**
 * Validates and tidies a model reply. Throws when the reply is not usable, so the caller falls back to no
 * summary. Longer text than allowed is cut at a sentence or dropped, never passed through.
 *
 * Every figure the model wrote must be in the transcript. A summary sentence, action item or one-liner with a
 * figure that is not there is dropped on its own, and a summary left with no sentence throws. So a wrong
 * number never reaches the owner, and the rest of a good summary still does.
 */
export function parseSummary(kind: SummaryKind, out: unknown, transcript: string): SummaryResult {
  const reply = modelReply.parse(replyObject(out));
  const inTranscript = figureCheck(transcript);
  const summary = sentences(reply.summary).filter(inTranscript).slice(0, MAX_SUMMARY_SENTENCES).join(" ");
  if (!summary) throw new Error("no summary sentence left after the checks");
  const isNone = (s: string) => s.replace(/[.!]$/, "").toLowerCase() === NO_MESSAGE.toLowerCase();
  if (isNone(summary)) return emptySummary(kind);
  const actionItems = reply.actionItems
    .map((item) => item.replace(/\.$/, ""))
    .filter(
      (item) =>
        item &&
        !isNone(item) &&
        !CONDITIONAL.test(item) &&
        words(item).length <= MAX_ACTION_ITEM_WORDS &&
        inTranscript(item),
    );
  let oneLiner: string | null = null;
  if (kind === "voicemail") {
    const line = reply.oneLiner?.replace(/[.!]$/, "") ?? "";
    if (!line) throw new Error("missing one-liner");
    oneLiner = words(line).length <= MAX_ONE_LINER_WORDS && inTranscript(line) ? line : null;
  }
  return { summary, actionItems, oneLiner };
}
