import { describe, expect, it } from "vitest";
import { safeNext } from "../../src/client/lib/safe-next";

describe("safeNext", () => {
  it("keeps same-site paths with query and hash", () => {
    expect(safeNext("/messages")).toBe("/messages");
    expect(safeNext("/messages?c=1#top")).toBe("/messages?c=1#top");
  });

  it.each([
    undefined,
    "",
    "messages",
    "//evil.com",
    "//evil.com/path",
    "/\\evil.com",
    "/\\/evil.com",
    "\\\\evil.com",
    "https://evil.com",
    "https://evil.com/keypad",
    "javascript:alert(1)",
    "/\tevil.com",
    "/%5Cevil.com/../..//evil.com\n",
  ])("falls back for %j", (v) => {
    expect(safeNext(v)).toBe("/keypad");
  });
});
