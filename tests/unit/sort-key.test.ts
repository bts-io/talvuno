import { describe, expect, it } from "vitest";
import { nameSortKey } from "../../src/lib/sort-key";

describe("nameSortKey", () => {
  it("folds case and accents", () => {
    expect(nameSortKey("Émile Dubois")).toBe("emile dubois");
    expect(nameSortKey("ZOË")).toBe("zoe");
    expect(nameSortKey("éclair")).toBe("eclair");
    expect(nameSortKey("Nguyễn")).toBe("nguyen");
  });

  it("sorts names the way people expect", () => {
    const names = ["Zoë Khan", "sarah Lee", "Émile Dubois", "Ben Ortiz"];
    const sorted = [...names].sort((a, b) => (nameSortKey(a) < nameSortKey(b) ? -1 : 1));
    expect(sorted).toEqual(["Ben Ortiz", "Émile Dubois", "sarah Lee", "Zoë Khan"]);
  });

  it("keeps vowel signs in Devanagari, Bengali and Thai", () => {
    expect(nameSortKey("कीता")).toBe("कीता");
    expect(nameSortKey("कोता")).toBe("कोता");
    expect(nameSortKey("कीता")).not.toBe(nameSortKey("कोता"));
    expect(nameSortKey("কীর্তি")).toBe("কীর্তি".normalize("NFD"));
    expect(nameSortKey("สมชาย")).toBe("สมชาย");
  });

  it("keeps letters with no decomposition", () => {
    expect(nameSortKey("Øvergård")).toBe("øvergard");
    expect(nameSortKey("Straße")).toBe("straße");
  });
});
