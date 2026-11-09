import { describe, expect, it } from "vitest";
import { dirFor, pickLocale } from "../../src/shared/i18n";
import en from "../../src/shared/locales/en.json";

// Built from escapes so the source file itself stays free of the characters it checks for.
// biome-ignore lint/complexity/useRegexLiterals: a literal would be rewritten to the raw characters
const DASHES = new RegExp("[\\u2013\\u2014]");

const strings = (o: unknown): string[] =>
  typeof o === "string" ? [o] : o && typeof o === "object" ? Object.values(o).flatMap(strings) : [];

describe("i18n", () => {
  it("ships English only and falls back to it", () => {
    expect(pickLocale("fr", "fr-FR,de;q=0.8")).toBe("en");
    expect(pickLocale(undefined, "en-AU")).toBe("en");
  });

  it("knows the direction of right-to-left languages before they ship", () => {
    expect(dirFor("en")).toBe("ltr");
    expect(dirFor("ar")).toBe("rtl");
    expect(dirFor("ur-PK")).toBe("rtl");
  });

  it("keeps UI strings free of em and en dashes", () => {
    for (const s of strings(en)) expect(s, s).not.toMatch(DASHES);
  });
});
