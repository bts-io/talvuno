import { describe, expect, it, vi } from "vitest";
import { clearAllDrafts } from "../../src/client/lib/drafts";
import { cleanupBeforeSignOut } from "../../src/client/lib/sign-out-cleanup";

function fakeStore(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("clearAllDrafts", () => {
  it("removes every draft key and nothing else", () => {
    const store = fakeStore({ "talvuno:draft:a": "x", "talvuno:draft:b": "y", theme: "dark" });
    clearAllDrafts(store);
    expect([...store.data.keys()]).toEqual(["theme"]);
  });
});

describe("cleanupBeforeSignOut", () => {
  it("unsubscribes first, then clears drafts", async () => {
    const order: string[] = [];
    await cleanupBeforeSignOut({
      unsubscribe: async () => void order.push("unsubscribe"),
      clearDrafts: () => void order.push("drafts"),
    });
    expect(order).toEqual(["unsubscribe", "drafts"]);
  });

  it("still clears drafts when unsubscribing fails", async () => {
    const clearDrafts = vi.fn();
    await cleanupBeforeSignOut({ unsubscribe: () => Promise.reject(new Error("offline")), clearDrafts });
    expect(clearDrafts).toHaveBeenCalled();
  });
});
