import { describe, expect, it } from "vitest";
import { menuKeysSchema, numberMenuInputSchema } from "../../src/contracts/menus";
import { decideMenuChoice, type MenuConfig, parseAttempt } from "../../src/worker/lib/voice/menu-rules";

const MENU: MenuConfig = {
  prompt: "Press 1 or 2",
  keys: [
    { digit: "1", action: "ring" },
    { digit: "2", action: "forward", to: "+14155552672" },
  ],
  defaultAction: "voicemail",
};

describe("phone menu rules", () => {
  it("runs the action of a known key on any attempt", () => {
    expect(decideMenuChoice(MENU, "1", 1)).toEqual({ kind: "ring" });
    expect(decideMenuChoice(MENU, "2", 2)).toEqual({ kind: "forward", to: "+14155552672" });
  });

  it("repeats once on no key or an unknown key, then takes the default", () => {
    expect(decideMenuChoice(MENU, undefined, 1)).toEqual({ kind: "repeat", attempt: 2 });
    expect(decideMenuChoice(MENU, "9", 1)).toEqual({ kind: "repeat", attempt: 2 });
    expect(decideMenuChoice(MENU, "", 2)).toEqual({ kind: "voicemail" });
    expect(decideMenuChoice({ ...MENU, defaultAction: "ring" }, "#", 2)).toEqual({ kind: "ring" });
  });

  it("reads anything but a first attempt as the last one, so a forged attempt never loops", () => {
    expect(parseAttempt(undefined)).toBe(1);
    expect(parseAttempt("1")).toBe(1);
    expect(parseAttempt("2")).toBe(2);
    expect(parseAttempt("0")).toBe(2);
    expect(parseAttempt("x")).toBe(2);
  });

  it("validates keys: 1 to 9 once each, E.164 forwards only", () => {
    expect(menuKeysSchema.safeParse(MENU.keys).success).toBe(true);
    expect(menuKeysSchema.safeParse([{ digit: "1", action: "forward", to: "12345" }]).success).toBe(false);
    expect(menuKeysSchema.safeParse([{ digit: "*", action: "ring" }]).success).toBe(false);
    const nine = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => ({ digit: d, action: "ring" }));
    expect(menuKeysSchema.safeParse(nine).success).toBe(true);
    expect(menuKeysSchema.safeParse([...nine, { digit: "1", action: "voicemail" }]).success).toBe(false);
  });

  it("needs a prompt and a key only when the menu is on", () => {
    const base = { prompt: "", keys: [], defaultAction: "ring" };
    expect(numberMenuInputSchema.safeParse({ ...base, enabled: false }).success).toBe(true);
    expect(numberMenuInputSchema.safeParse({ ...base, enabled: true }).success).toBe(false);
  });
});
