import { describe, expect, it, vi } from "vitest";
import { declineTextNumber, declineWithText, fillDraft } from "../../src/lib/quick-replies";

const numbers = [
  { id: "n1", e164: "+14155550100", friendlyName: "", isDefault: true },
  { id: "n2", e164: "+14155550101", friendlyName: "", isDefault: false },
];

describe("fillDraft", () => {
  it("fills an empty box and adds to typed text, never sending", () => {
    expect(fillDraft("", "On my way")).toBe("On my way");
    expect(fillDraft("   ", "On my way")).toBe("On my way");
    expect(fillDraft("Hi ", "On my way")).toBe("Hi On my way");
  });
});

describe("declineTextNumber", () => {
  it("returns the number that was called when the caller is a full number", () => {
    expect(declineTextNumber({ party: "+14155552671", numberId: "n2" }, numbers)?.e164).toBe("+14155550101");
  });

  it("hides the control for withheld callers, short codes and unknown numbers", () => {
    expect(declineTextNumber({ party: "anonymous", numberId: "n1" }, numbers)).toBeNull();
    expect(declineTextNumber({ party: "", numberId: "n1" }, numbers)).toBeNull();
    expect(declineTextNumber({ party: "72345", numberId: "n1" }, numbers)).toBeNull();
    expect(declineTextNumber({ party: "+14155552671", numberId: null }, numbers)).toBeNull();
    expect(declineTextNumber({ party: "+14155552671", numberId: "gone" }, numbers)).toBeNull();
    expect(declineTextNumber({ party: "+14155552671", numberId: "n1" }, undefined)).toBeNull();
    expect(declineTextNumber(null, numbers)).toBeNull();
  });
});

describe("declineWithText", () => {
  it("sends the text and then declines", async () => {
    const order: string[] = [];
    const result = await declineWithText("Call you back", {
      send: async (text) => void order.push(`send:${text}`),
      decline: () => void order.push("decline"),
    });
    expect(result).toEqual({ ok: true });
    expect(order).toEqual(["send:Call you back", "decline"]);
  });

  it("keeps the call ringing and returns the error when the send is refused", async () => {
    const decline = vi.fn();
    const error = new Error("That country is not in your allowed list");
    const result = await declineWithText("Call you back", {
      send: async () => {
        throw error;
      },
      decline,
    });
    expect(result).toEqual({ ok: false, error });
    expect(decline).not.toHaveBeenCalled();
  });
});
