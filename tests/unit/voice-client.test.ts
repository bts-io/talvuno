import { describe, expect, it, vi } from "vitest";
import {
  callFailureKey,
  cleanDialInput,
  deviceSetupFailure,
  formatCallTime,
  isOwnCallFailure,
  type RegisteringDevice,
  registerDevice,
  setupErrorKey,
  singleFlight,
  stopsCalling,
  voiceErrorKey,
} from "../../src/client/lib/voice";
import en from "../../src/shared/locales/en.json";

describe("voiceErrorKey", () => {
  it("maps Twilio Voice SDK codes to plain messages", () => {
    expect(voiceErrorKey(31401)).toBe("micDenied");
    expect(voiceErrorKey(31402)).toBe("micUnavailable");
    expect(voiceErrorKey(20104)).toBe("token");
    expect(voiceErrorKey(31486)).toBe("declined");
    expect(voiceErrorKey(53405)).toBe("network");
    expect(voiceErrorKey(undefined)).toBe("generic");
    expect(voiceErrorKey(99999)).toBe("generic");
  });

  it("names refused calling credentials instead of blaming the connection", () => {
    for (const code of [20101, 20102, 20103, 20105, 20106, 20107, 20151, 20157, 31202, 31204, 31207]) {
      expect(voiceErrorKey(code), String(code)).toBe("credentials");
      expect(setupErrorKey(code), String(code)).toBe("credentials");
      expect(stopsCalling(voiceErrorKey(code))).toBe(true);
    }
    expect(en.voice.errors.credentials).toContain("Setup check");
    expect(en.voice.errors.credentials).not.toMatch(/internet/i);
    // Expired tokens are fixed by a new token, so they keep the Retry message.
    expect(setupErrorKey(20104)).toBe("token");
    expect(setupErrorKey(31205)).toBe("token");
    expect(setupErrorKey(53405)).toBe("setup");
    expect(setupErrorKey(undefined)).toBe("setup");
    expect(stopsCalling("network")).toBe(false);
  });

  it("has an en.json message for every key it can return", () => {
    const codes = [20101, 20104, 31401, 31402, 31486, 31404, 31005, 31001, 31206, 0];
    for (const code of codes) expect(en.voice.errors).toHaveProperty(voiceErrorKey(code));
  });
});

describe("formatCallTime", () => {
  it("counts minutes and hours", () => {
    expect(formatCallTime(0)).toBe("0:00");
    expect(formatCallTime(65)).toBe("1:05");
    expect(formatCallTime(3725)).toBe("1:02:05");
  });
});

describe("cleanDialInput", () => {
  it("keeps dialable characters from pasted text, with one leading plus", () => {
    expect(cleanDialInput("Tel: +1 (415) 555-2671")).toBe("+14155552671");
    expect(cleanDialInput("415+555")).toBe("415555");
    expect(cleanDialInput("++44 7911")).toBe("+447911");
    expect(cleanDialInput("*86#")).toBe("*86#");
  });
});

describe("deviceSetupFailure", () => {
  it("sends an expired session to login and offers a retry for anything else", () => {
    expect(deviceSetupFailure(Object.assign(new Error("Sign in"), { status: 401 }))).toBe("login");
    expect(deviceSetupFailure(Object.assign(new Error("Not set up"), { status: 503 }))).toBe("retry");
    expect(deviceSetupFailure(new TypeError("Failed to fetch"))).toBe("retry");
    expect(deviceSetupFailure({ code: 20104 })).toBe("retry");
    expect(deviceSetupFailure(null)).toBe("retry");
  });

  it("has an en.json message for the setup failure and the retry button", () => {
    expect(en.voice.errors).toHaveProperty("setup");
    expect(en.voice).toHaveProperty("retry");
  });
});

/** A Device that behaves like the SDK when Twilio refuses the token: an `error` event, then register rejects. */
function refusingDevice(errors: ({ code?: number } | undefined)[], rejectWith?: unknown) {
  let listener: ((err: { code?: number } | undefined) => void) | undefined;
  const device: RegisteringDevice = {
    on: (_event, fn) => {
      listener = fn;
    },
    register: async () => {
      for (const err of errors) listener?.(err);
      if (rejectWith !== undefined) throw rejectWith;
    },
  };
  return { device, emit: (err: { code?: number }) => listener?.(err) };
}

describe("registerDevice", () => {
  it("shows the credentials message when a Device error carries 20101 during setup", async () => {
    const onSetupFailed = vi.fn();
    const onError = vi.fn();
    // The SDK rejects register() with a code-less error after the AccessTokenInvalid event.
    const { device } = refusingDevice([{ code: 20101 }], new Error("unregistered"));
    await registerDevice(device, onSetupFailed, onError);
    expect(onSetupFailed).toHaveBeenCalledTimes(1);
    const shown = setupErrorKey((onSetupFailed.mock.calls[0]?.[0] as { code?: number } | undefined)?.code);
    expect(shown).toBe("credentials");
    expect(en.voice.errors[shown as keyof typeof en.voice.errors]).toContain("Setup check");
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports every credential code once, ahead of the register rejection", async () => {
    for (const code of [20101, 20102, 20103, 20106, 20107, 20151, 31202, 31204, 31207]) {
      const onSetupFailed = vi.fn();
      await registerDevice(refusingDevice([{ code }], undefined).device, onSetupFailed, vi.fn());
      expect(onSetupFailed, String(code)).toHaveBeenCalledTimes(1);
      expect(setupErrorKey(onSetupFailed.mock.calls[0]?.[0]?.code), String(code)).toBe("credentials");
    }
  });

  it("falls back to the setup message when register fails without a Device error", async () => {
    const onSetupFailed = vi.fn();
    await registerDevice(refusingDevice([], new Error("offline")).device, onSetupFailed, vi.fn());
    expect(onSetupFailed).toHaveBeenCalledTimes(1);
    expect(setupErrorKey((onSetupFailed.mock.calls[0]?.[0] as { code?: number } | undefined)?.code)).toBe(
      "setup",
    );
  });

  it("passes errors that do not stop calling to onError", async () => {
    const onSetupFailed = vi.fn();
    const onError = vi.fn();
    const { device, emit } = refusingDevice([]);
    await registerDevice(device, onSetupFailed, onError);
    emit({ code: 31005 });
    expect(onError).toHaveBeenCalledWith({ code: 31005 });
    expect(onSetupFailed).not.toHaveBeenCalled();
  });
});

describe("callFailureKey", () => {
  it("names the Twilio call failures and falls back to the code", () => {
    expect(callFailureKey(13227)).toBe("geoPermission");
    expect(callFailureKey(21215)).toBe("geoPermission");
    expect(callFailureKey(13225)).toBe("callBlocked");
    expect(callFailureKey(13224)).toBe("invalidNumber");
    expect(callFailureKey(13223)).toBe("unknownNumberFormat");
    expect(callFailureKey(13214)).toBe("callerIdNotOwned");
    expect(callFailureKey(31999)).toBe("callFailed");
  });

  it("has a message for every key, and the fallback shows the code", () => {
    const errors = en.voice.errors as Record<string, string>;
    for (const code of [13227, 13225, 13224, 13223, 21215, 13214, 99999])
      expect(errors[callFailureKey(code)], String(code)).toBeTruthy();
    expect(errors.callFailed).toContain("{{code}}");
    expect(errors.callBlocked).toBe(
      "Twilio blocked this call (fraud risk or regulation for the destination). Check the call log in the Twilio console.",
    );
    expect(errors).not.toHaveProperty("callerIdGeoPermission");
    expect(errors.geoPermission).toBe(
      "Twilio blocks calls to this country on your account. Allow it under Voice Geo Permissions in the Twilio console.",
    );
  });
});

describe("singleFlight", () => {
  it("ignores a second call while the first is running, then allows the next", async () => {
    let release: () => void = () => {};
    const action = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const changes: boolean[] = [];
    const run = singleFlight(action, (busy) => changes.push(busy));
    const first = run();
    await run();
    expect(action).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(changes).toEqual([true, false]);
    const again = run();
    release();
    await again;
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("lets go when the action throws", async () => {
    const run = singleFlight(async () => {
      throw new Error("boom");
    });
    await expect(run()).rejects.toThrow("boom");
    await expect(run()).rejects.toThrow("boom");
  });
});

describe("isOwnCallFailure", () => {
  it("matches only the call this tab placed", () => {
    expect(isOwnCallFailure("CA1", "CA1")).toBe(true);
    expect(isOwnCallFailure("CA1", "CA2")).toBe(false);
    expect(isOwnCallFailure("CA1", null)).toBe(false);
    expect(isOwnCallFailure(undefined, "CA1")).toBe(false);
    expect(isOwnCallFailure(undefined, null)).toBe(false);
  });
});
