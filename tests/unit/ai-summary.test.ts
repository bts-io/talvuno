import { describe, expect, it } from "vitest";
import { aiSummarySchema } from "../../src/contracts/ai-summary";
import {
  ACTION_ITEM_PROMPT_WORDS,
  emptySummary,
  figureCheck,
  isNoMessage,
  MAX_ACTION_ITEM_WORDS,
  MAX_ONE_LINER_WORDS,
  MAX_TRANSCRIPT_CHARS,
  NO_MESSAGE,
  noDashes,
  parseSummary as parseWith,
  sentences,
  summaryInput,
  summarySchema,
} from "../../src/worker/lib/ai/summary-prompt";

// Built from escapes so the source file itself stays free of the characters it checks for.
// biome-ignore lint/complexity/useRegexLiterals: a literal would be rewritten to the raw characters
const DASHES = new RegExp("[\\u2013\\u2014]");
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

const chat = (content: unknown) => ({ choices: [{ message: { role: "assistant", content } }] });
const reply = (o: Record<string, unknown>) => chat(JSON.stringify(o));

/** Holds every figure the tests below put in a reply, so only the figure tests drop anything for a figure. */
const TRANSCRIPT = "Sam called about the quote. Call 0400 111 222, order 88213, we are open 9 to 5.";
const parseSummary = (kind: "voicemail" | "call", out: unknown, transcript = TRANSCRIPT) =>
  parseWith(kind, out, transcript);

describe("summary prompt", () => {
  it("asks for a strict JSON schema, with the one-liner only for voicemail", () => {
    const vm = summaryInput("voicemail", "Hi, it's Sam, call me back please.")!;
    expect(vm.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "summary", schema: summarySchema("voicemail"), strict: true },
    });
    expect(summarySchema("voicemail").required).toEqual(["summary", "actionItems", "oneLiner"]);
    expect(summarySchema("call").required).toEqual(["summary", "actionItems"]);
    expect(vm.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("keeps the prompt itself free of em and en dashes and tells the model not to use them", () => {
    for (const kind of ["voicemail", "call"] as const) {
      const text = JSON.stringify(summaryInput(kind, "Hi, it's Sam, call me back please."));
      expect(text).not.toMatch(DASHES);
      expect(text).toContain("Do not use dashes");
      expect(text).toContain("Never add names, numbers");
      expect(text).toContain("Do not give advice");
    }
  });

  it("cuts a very long transcript before it is sent", () => {
    const long = "word ".repeat(MAX_TRANSCRIPT_CHARS);
    const content = summaryInput("call", long)!.messages[1]!.content;
    expect(content.length).toBeLessThan(MAX_TRANSCRIPT_CHARS + 100);
  });

  it("treats silence, noise and stray words as no message, without the model", () => {
    for (const t of ["", "   ", "you", "you ... [inaudible] ...", "(noise) uh .", "Hmm."])
      expect(isNoMessage(t), t).toBe(true);
    expect(isNoMessage("Call me back on 0400 111 222")).toBe(false);
    expect(summaryInput("voicemail", "[inaudible]")).toBeNull();
    expect(emptySummary("voicemail")).toEqual({ summary: NO_MESSAGE, actionItems: [], oneLiner: NO_MESSAGE });
    expect(emptySummary("call")).toEqual({ summary: NO_MESSAGE, actionItems: [], oneLiner: null });
  });
});

describe("parseSummary", () => {
  const good = {
    summary: "Sam called about the quote.",
    actionItems: ["Call Sam back on 0400 111 222."],
    oneLiner: "Sam wants a call back about the quote.",
  };

  it("accepts the chat shape, the older response shape and a parsed object", () => {
    const expected = {
      summary: "Sam called about the quote.",
      actionItems: ["Call Sam back on 0400 111 222"],
      oneLiner: "Sam wants a call back about the quote",
    };
    expect(parseSummary("voicemail", reply(good))).toEqual(expected);
    expect(parseSummary("voicemail", { response: JSON.stringify(good) })).toEqual(expected);
    expect(parseSummary("voicemail", { response: good })).toEqual(expected);
    expect(parseSummary("voicemail", chat(good))).toEqual(expected);
    expect(aiSummarySchema.parse(expected)).toEqual(expected);
  });

  it("throws on any reply it cannot use", () => {
    const bad: unknown[] = [
      null,
      "plain text",
      chat("not json"),
      chat(null),
      reply({ summary: "", actionItems: [], oneLiner: "x" }),
      reply({ summary: 7, actionItems: [], oneLiner: "x" }),
      reply({ summary: "Fine.", actionItems: "call back", oneLiner: "x" }),
      reply({ summary: "Fine.", actionItems: ["a", "b", "c", "d"], oneLiner: "x" }),
      reply({ summary: "x".repeat(601), actionItems: [], oneLiner: "x" }),
      reply({ summary: "A voicemail with no one-liner.", actionItems: [] }),
    ];
    for (const out of bad) expect(() => parseSummary("voicemail", out), JSON.stringify(out)).toThrow();
  });

  it("removes em and en dashes from everything the model wrote", () => {
    const out = parseSummary(
      "voicemail",
      reply({
        summary: `Sam called ${EM} about the quote. Open 9${EN}5 today.`,
        actionItems: [`Call Sam ${EN} today`],
        oneLiner: `Sam${EM}a call back`,
      }),
    );
    expect(JSON.stringify(out)).not.toMatch(DASHES);
    expect(out.summary).toBe("Sam called, about the quote. Open 9 to 5 today.");
    expect(out.actionItems).toEqual(["Call Sam, today"]);
    expect(noDashes(`a ${EM} b`)).toBe("a, b");
  });

  it("keeps at most two sentences, items up to 16 words, and drops a one-liner over 12", () => {
    const sixteen = "Pick up the parcel at the post office on King Street after two tomorrow with ID";
    const seventeen = `${sixteen} please`;
    const thirteen = "one two three four five six seven eight nine ten eleven twelve thirteen";
    expect(sixteen.split(" ")).toHaveLength(MAX_ACTION_ITEM_WORDS);
    expect(MAX_ONE_LINER_WORDS).toBe(12);
    const out = parseSummary(
      "voicemail",
      reply({
        summary: "One. Two! Three? Four.",
        actionItems: [thirteen, sixteen, seventeen],
        oneLiner: thirteen,
      }),
    );
    expect(out).toEqual({ summary: "One. Two!", actionItems: [thirteen, sixteen], oneLiner: null });
  });

  it("asks the model for 12 word items, below the 16 the gate allows", () => {
    expect(ACTION_ITEM_PROMPT_WORDS).toBe(12);
    expect(MAX_ACTION_ITEM_WORDS).toBe(16);
    for (const kind of ["voicemail", "call"] as const) {
      const prompt = summaryInput(kind, "Hi, it's Sam, call me back please.")!.messages[0]!.content;
      expect(prompt).toContain("each at most 12 words");
      expect(prompt).not.toContain("16 words");
    }
  });

  it("drops action items that hang on a condition: those are threats, not tasks", () => {
    const out = parseSummary(
      "voicemail",
      reply({
        summary: "Daniel wants a refund if he does not hear back today.",
        actionItems: ["Call Daniel back today", "Provide a full refund if no response today"],
        oneLiner: "Daniel wants a call back about order 88213",
      }),
    );
    expect(out.actionItems).toEqual(["Call Daniel back today"]);
  });

  it("maps a model No message to the empty summary", () => {
    expect(
      parseSummary(
        "voicemail",
        reply({ summary: "No message.", actionItems: ["No message"], oneLiner: "x" }),
      ),
    ).toEqual(emptySummary("voicemail"));
    expect(parseSummary("call", reply({ summary: "No message", actionItems: [] }))).toEqual(
      emptySummary("call"),
    );
  });

  it("has no one-liner for a call even when the model sends one", () => {
    expect(
      parseSummary("call", reply({ summary: "We agreed on Friday.", actionItems: [], oneLiner: "x" }))
        .oneLiner,
    ).toBeNull();
  });
});

describe("sentences", () => {
  it("never splits a figure on its decimal point", () => {
    expect(sentences("The bill is $1,250.75 in total. Pay it by Friday.")).toEqual([
      "The bill is $1,250.75 in total.",
      "Pay it by Friday.",
    ]);
    expect(sentences("Meet at 3.30pm at the cafe.")).toEqual(["Meet at 3.30pm at the cafe."]);
    expect(sentences("Rates rose 12.5 percent. That is all.")).toEqual([
      "Rates rose 12.5 percent.",
      "That is all.",
    ]);
  });

  it("never splits after a title, an abbreviation or an initial", () => {
    expect(sentences("Dr. Smith called about your results. He wants a call back.")).toEqual([
      "Dr. Smith called about your results.",
      "He wants a call back.",
    ]);
    expect(sentences("Mr. and Mrs. Lee from 4 King St. are coming. Ms. Park too.")).toEqual([
      "Mr. and Mrs. Lee from 4 King St. are coming.",
      "Ms. Park too.",
    ]);
    expect(sentences("Bring ID, e.g. a licence, a card etc. to collect. Thanks.")).toEqual([
      "Bring ID, e.g. a licence, a card etc. to collect.",
      "Thanks.",
    ]);
    expect(sentences("John R. Smith rang. Bye.")).toEqual(["John R. Smith rang.", "Bye."]);
  });

  it("never splits inside an email address or a URL", () => {
    expect(sentences("Email sam.lee@acme.com.au today. Or see https://acme.com/a.b?x=1.2 now.")).toEqual([
      "Email sam.lee@acme.com.au today.",
      "Or see https://acme.com/a.b?x=1.2 now.",
    ]);
  });

  it("still splits ordinary sentences, with or without a closing quote", () => {
    expect(sentences('One. Two! Three? He said "yes." Done')).toEqual([
      "One.",
      "Two!",
      "Three?",
      'He said "yes."',
      "Done",
    ]);
    expect(sentences("")).toEqual([]);
  });

  it("keeps figures and a second sentence whole through parseSummary", () => {
    const t = "Dr. Smith here. Your bill is $1,250.75, 12.5 percent off, pay by 3.30pm. Call back.";
    const result = {
      summary: "Dr. Smith called about a $1,250.75 bill, 12.5 percent off. He wants a call back by 3.30pm.",
      actionItems: ["Pay $1,250.75 by 3.30pm"],
      oneLiner: "Dr. Smith wants payment of $1,250.75",
    };
    expect(parseSummary("voicemail", reply(result), t)).toEqual(result);
  });
});

describe("figures against the transcript", () => {
  it("compares digits only, so spacing and punctuation may differ", () => {
    const check = figureCheck(
      "Call me on 0412345678 or (02) 9555 0142 ext. 318, about the $4,500 invoice at 10:30.",
    );
    expect(check("Call 0412 345 678")).toBe(true);
    expect(check("Call 02 9555 0142, extension 318")).toBe(true);
    expect(check("Call 0295550142")).toBe(true);
    expect(check("The 4500 dollar invoice, at 10.30")).toBe(true);
    expect(check("No figures here")).toBe(true);
    expect(figureCheck("Call 0412 345 678.")("Call 0412345678")).toBe(true);
    expect(figureCheck("Call 0412345678.")("Call 0412 345 678")).toBe(true);
    expect(figureCheck("Call (02) 9555-0142.")("Call 02 9555 0142")).toBe(true);
  });

  it("refuses part of one grouped figure", () => {
    expect(figureCheck("The invoice says 4,500.")("$500")).toBe(false);
    expect(figureCheck("The invoice says 4,500.")("4")).toBe(false);
    expect(figureCheck("It came to $1,250.75.")("$1,250")).toBe(false);
    expect(figureCheck("It came to $1,250.75.")("75")).toBe(false);
    expect(figureCheck("Come at 3:30.")("30")).toBe(false);
    expect(figureCheck("Come at 3:30.")("3:30")).toBe(true);
    expect(figureCheck("It came to $1,250.75.")("$1,250.75")).toBe(true);
  });

  it("still takes part of a number split by spaces, brackets or hyphens", () => {
    expect(figureCheck("Call (02) 9555-0142.")("9555 0142")).toBe(true);
    expect(figureCheck("Call 0412 345 678.")("0412")).toBe(true);
  });

  it("fails a figure that is not in the transcript, even one that is part of another", () => {
    const check = figureCheck("The invoice says 4,500 and the order is 88213, due 1,250.");
    expect(check("It says 4,000")).toBe(false);
    expect(check("Order 8821")).toBe(false);
    expect(check("Order 88214")).toBe(false);
    expect(check("It says 450")).toBe(false);
    expect(check("Pay 12")).toBe(false);
    expect(check("Pay 4,500 for order 88213")).toBe(true);
  });

  it("drops just the sentence, item or one-liner with a wrong figure", () => {
    const t = "Hi it's Imran. The invoice says 4,500 but we agreed on 4,000. Please call 0400 111 222.";
    const out = parseSummary(
      "voicemail",
      reply({
        summary: "Imran says the invoice should be 4,200. He asks you to check it.",
        actionItems: ["Resend the invoice for 4,200", "Call Imran on 0400 111 222"],
        oneLiner: "Imran wants the invoice changed to 4,200",
      }),
      t,
    );
    expect(out).toEqual({
      summary: "He asks you to check it.",
      actionItems: ["Call Imran on 0400 111 222"],
      oneLiner: null,
    });
  });

  it("fails the whole summary when no sentence is left", () => {
    expect(() =>
      parseSummary(
        "call",
        reply({ summary: "You agreed on 300 dollars.", actionItems: [] }),
        "We agreed on three hundred dollars.",
      ),
    ).toThrow();
  });

  it("asks the model to write numbers the way the transcript does", () => {
    const text = JSON.stringify(summaryInput("voicemail", "Hi, it's Sam, call me back please."));
    expect(text).toContain("four days stays four days");
  });
});
