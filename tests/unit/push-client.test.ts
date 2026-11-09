import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDraft, draftStorageKey, readDraft, writeDraft } from "../../src/client/lib/drafts";
import { isIos, pushSupport, urlBase64ToUint8Array } from "../../src/client/lib/push-support";
import en from "../../src/shared/locales/en.json";

describe("pushSupport", () => {
  it("asks iPhone and iPad users to install the app first", () => {
    expect(pushSupport({ ios: true, standalone: false, hasPush: false })).toBe("needs-install");
    expect(pushSupport({ ios: true, standalone: false, hasPush: true })).toBe("needs-install");
    expect(pushSupport({ ios: true, standalone: true, hasPush: true })).toBe("ready");
  });

  it("reports browsers without the Push API as unsupported", () => {
    expect(pushSupport({ ios: false, standalone: false, hasPush: false })).toBe("unsupported");
    expect(pushSupport({ ios: false, standalone: false, hasPush: true })).toBe("ready");
  });

  it("recognises iOS, including iPadOS that poses as a Mac", () => {
    expect(isIos("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)")).toBe(true);
    expect(isIos("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe(true);
    expect(isIos("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe(false);
    expect(isIos("Mozilla/5.0 (Linux; Android 14)")).toBe(false);
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodes the VAPID public key to its 65 bytes", () => {
    const key = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    const bytes = urlBase64ToUint8Array(key);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4);
    expect(Buffer.from(bytes).toString("base64url")).toBe(key);
  });
});

describe("message drafts", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps one draft per conversation under a Talvuno prefix", () => {
    writeDraft("conv-1", "hello");
    writeDraft("conv-2", "other");
    expect(readDraft("conv-1")).toBe("hello");
    expect(readDraft("conv-2")).toBe("other");
    expect(readDraft("conv-3")).toBe("");
    expect([...store.keys()].every((k) => k.startsWith("talvuno:draft:"))).toBe(true);
    expect(store.has(draftStorageKey("conv-1"))).toBe(true);
  });

  it("removes the entry when the draft is emptied or cleared", () => {
    writeDraft("conv-1", "hello");
    writeDraft("conv-1", "");
    expect(store.size).toBe(0);
    writeDraft("conv-1", "again");
    clearDraft("conv-1");
    expect(store.size).toBe(0);
  });

  it("survives storage that throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {},
    });
    expect(readDraft("x")).toBe("");
    expect(() => writeDraft("x", "text")).not.toThrow();
  });
});

describe("push strings", () => {
  it("has every key the Settings section asks for", () => {
    for (const code of ["denied", "not_configured", "unsupported", "generic"] as const)
      expect(en.push.error[code]).toBeTruthy();
    for (const state of ["loading", "on", "off", "denied"] as const)
      expect(en.push.state[state]).toBeTruthy();
  });
});
