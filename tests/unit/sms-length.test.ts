import { describe, expect, it } from "vitest";
import { smsLength } from "../../src/lib/sms";

describe("smsLength", () => {
  it("counts GSM-7 segments at 160, then 153 each", () => {
    expect(smsLength("")).toMatchObject({ segments: 0, remaining: 160 });
    expect(smsLength("a".repeat(160))).toMatchObject({ encoding: "GSM-7", segments: 1, remaining: 0 });
    expect(smsLength("a".repeat(161))).toMatchObject({ segments: 2, remaining: 306 - 161 });
  });

  it("counts extension characters twice", () => {
    expect(smsLength("€".repeat(80))).toMatchObject({ encoding: "GSM-7", units: 160, segments: 1 });
    expect(smsLength("[".repeat(81)).segments).toBe(2);
  });

  it("switches to UCS-2 at 70, then 67 each", () => {
    expect(smsLength(`${"a".repeat(69)}é`).encoding).toBe("GSM-7");
    expect(smsLength("ą".repeat(70))).toMatchObject({ encoding: "UCS-2", segments: 1 });
    expect(smsLength("ą".repeat(71))).toMatchObject({ segments: 2 });
    expect(smsLength("😀")).toMatchObject({ encoding: "UCS-2", characters: 1, units: 2 });
  });
});
