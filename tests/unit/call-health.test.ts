import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasTurn,
  ICE_PROBE_TIMEOUT_MS,
  isTrailingTransportError,
  MAX_TRANSPORT_ERRORS,
  type ProbePeerConnection,
  probeIce,
  RECONNECT_GIVE_UP_MS,
  superviseCall,
  type Timers,
  webrtcBlocked,
} from "../../src/client/lib/call-health";
import type { IceConfiguration, IceServer } from "../../src/client/lib/ice-servers";
import en from "../../src/shared/locales/en.json";

type AnyListener = (...args: any[]) => void;

/** A tiny event emitter standing in for the SDK Call or Device. */
function emitter() {
  const listeners = new Map<string, Set<AnyListener>>();
  return {
    on(event: string, l: AnyListener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(l);
    },
    removeListener(event: string, l: AnyListener) {
      listeners.get(event)?.delete(l);
    },
    emit(event: string, ...args: unknown[]) {
      for (const l of [...(listeners.get(event) ?? [])]) l(...args);
    },
    count(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

function fakeCall() {
  const e = emitter();
  const disconnect = vi.fn(() => e.emit("disconnect"));
  return { ...e, disconnect };
}

/** Timers driven by the test: `advance(ms)` fires what is due. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    setTimeout(fn, ms) {
      const id = next++;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      due.delete(id as number);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...due]) {
      if (t.at <= now) {
        due.delete(id);
        t.fn();
      }
    }
  };
  return { timers, advance, pending: () => due.size };
}

/**
 * The sequence the owner's browser logged on 2026-11-09: the call went to "reconnecting" while the far phone
 * rang, the gateway answered the SDK's reinvite burst with 31206, then every reinvite failed with 31009.
 */
describe("superviseCall", () => {
  it("ends an unanswered call as soon as Twilio refuses the reinvite rate (31206)", () => {
    const call = fakeCall();
    const device = emitter();
    const onGiveUp = vi.fn();
    superviseCall(call, device, onGiveUp, fakeTimers().timers);
    call.emit("ringing");
    call.emit("reconnecting", { code: 53001 });
    device.emit("error", { code: 31206 });
    for (let i = 0; i < 40; i++) device.emit("error", { code: 31009 });
    expect(call.disconnect).toHaveBeenCalledTimes(1);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp).toHaveBeenCalledWith("media");
    expect(en.voice.errors.media).toContain("WebRTC");
  });

  it("stops after a bounded number of failed sends while reconnecting", () => {
    const call = fakeCall();
    const device = emitter();
    const onGiveUp = vi.fn();
    superviseCall(call, device, onGiveUp, fakeTimers().timers);
    call.emit("reconnecting");
    for (let i = 0; i < MAX_TRANSPORT_ERRORS - 1; i++) device.emit("error", { code: 31009 });
    expect(call.disconnect).not.toHaveBeenCalled();
    device.emit("error", { code: 31009 });
    expect(call.disconnect).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) device.emit("error", { code: 31009 });
    expect(call.disconnect).toHaveBeenCalledTimes(1);
    expect(device.count("error")).toBe(0);
  });

  it("gives up when reconnecting lasts too long, and names the dropped connection for an answered call", () => {
    const call = fakeCall();
    const device = emitter();
    const onGiveUp = vi.fn();
    const t = fakeTimers();
    superviseCall(call, device, onGiveUp, t.timers);
    call.emit("accept");
    call.emit("reconnecting");
    t.advance(RECONNECT_GIVE_UP_MS - 1);
    expect(call.disconnect).not.toHaveBeenCalled();
    t.advance(1);
    expect(call.disconnect).toHaveBeenCalledTimes(1);
    expect(onGiveUp).toHaveBeenCalledWith("network");
  });

  it("leaves a call that recovers alone, and starts the count again", () => {
    const call = fakeCall();
    const device = emitter();
    const onGiveUp = vi.fn();
    const t = fakeTimers();
    superviseCall(call, device, onGiveUp, t.timers);
    call.emit("reconnecting");
    device.emit("error", { code: 31009 });
    device.emit("error", { code: 31009 });
    call.emit("reconnected");
    t.advance(RECONNECT_GIVE_UP_MS * 2);
    device.emit("error", { code: 31009 });
    device.emit("error", { code: 31206 });
    expect(call.disconnect).not.toHaveBeenCalled();
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it("ignores device errors outside reconnecting and lets go of everything when the call ends", () => {
    const call = fakeCall();
    const device = emitter();
    const onGiveUp = vi.fn();
    const t = fakeTimers();
    superviseCall(call, device, onGiveUp, t.timers);
    for (let i = 0; i < 10; i++) device.emit("error", { code: 31009 });
    expect(call.disconnect).not.toHaveBeenCalled();
    call.emit("reconnecting");
    call.emit("disconnect");
    t.advance(RECONNECT_GIVE_UP_MS);
    expect(t.pending()).toBe(0);
    expect(device.count("error")).toBe(0);
    expect(call.count("reconnecting")).toBe(0);
    expect(onGiveUp).not.toHaveBeenCalled();
  });
});

/** A peer connection that gathers the given candidates, then completes. */
function fakePc(candidates: string[], opts: { never?: boolean; offerFails?: boolean } = {}) {
  const close = vi.fn();
  const e = emitter();
  let state = "new";
  const pc = {
    addEventListener: (type: string, l: AnyListener) => e.on(type, l),
    get iceGatheringState() {
      return state;
    },
    createDataChannel: () => ({}),
    createOffer: () =>
      opts.offerFails ? Promise.reject(new Error("no")) : Promise.resolve({ type: "offer" }),
    async setLocalDescription() {
      if (opts.never) return;
      queueMicrotask(() => {
        state = "gathering";
        e.emit("icegatheringstatechange");
        for (const c of candidates) e.emit("icecandidate", { candidate: { candidate: c } });
        state = "complete";
        e.emit("icegatheringstatechange");
        e.emit("icecandidate", { candidate: null });
      });
    },
    close,
  } as ProbePeerConnection & { close: typeof close };
  return pc;
}

const STUN = { urls: "stun:global.stun.twilio.com:3478" };
const TURN = { urls: "turn:global.turn.twilio.com:443?transport=tcp", username: "u", credential: "c" };
const TWILIO_SERVERS: IceServer[] = [STUN, TURN];

describe("probeIce", () => {
  it("gathers with the ICE servers the call will use", async () => {
    const pc = fakePc(["candidate:2 1 udp 1686052607 203.0.113.7 50000 typ srflx"]);
    const create = vi.fn((_config: IceConfiguration) => pc);
    expect(await probeIce(create, TWILIO_SERVERS)).toBe("ok");
    expect(create).toHaveBeenCalledWith({ iceServers: TWILIO_SERVERS });
    expect(pc.close).toHaveBeenCalled();
  });

  it("reports blocked only when nothing gathers even with TURN offered", async () => {
    const pc = fakePc([]);
    expect(await probeIce(() => pc, TWILIO_SERVERS)).toBe("blocked");
    expect(pc.close).toHaveBeenCalled();
    expect(en.voice.errors.webrtcBlocked).toContain("not placed");
    expect(en.voice.errors.webrtcBlocked).toContain("relay");
    expect(en.voice.errors.webrtcBlocked).not.toMatch(/VPN/);
  });

  it("does not refuse a call when only STUN was offered", async () => {
    expect(await probeIce(() => fakePc([]), [STUN])).toBe("unknown");
  });

  it("allows the call without probing when the ICE servers could not be fetched", async () => {
    const create = vi.fn(() => fakePc([]));
    expect(await probeIce(create, null)).toBe("unknown");
    expect(await probeIce(create, [])).toBe("unknown");
    expect(create).not.toHaveBeenCalled();
  });

  it("is ok as soon as one candidate arrives", async () => {
    const pc = fakePc(["candidate:1 1 udp 2122260223 abc.local 50000 typ host"]);
    expect(await probeIce(() => pc, TWILIO_SERVERS)).toBe("ok");
    expect(pc.close).toHaveBeenCalled();
  });

  it("does not block the call when it cannot tell", async () => {
    expect(await probeIce(() => fakePc([], { offerFails: true }), TWILIO_SERVERS)).toBe("unknown");
    expect(
      await probeIce(() => {
        throw new Error("no RTCPeerConnection");
      }, TWILIO_SERVERS),
    ).toBe("unknown");
    const t = fakeTimers();
    const pending = probeIce(() => fakePc([], { never: true }), TWILIO_SERVERS, t.timers);
    await Promise.resolve();
    t.advance(ICE_PROBE_TIMEOUT_MS);
    expect(await pending).toBe("unknown");
  });
});

describe("hasTurn", () => {
  it("finds turn and turns URLs, also inside a urls array", () => {
    expect(hasTurn([STUN])).toBe(false);
    expect(hasTurn([STUN, TURN])).toBe(true);
    expect(hasTurn([{ urls: ["stun:a", "turns:b:443"] }])).toBe(true);
  });
});

describe("isTrailingTransportError", () => {
  it("hides only the transport errors that trail an app-ended call", () => {
    expect(isTrailingTransportError(31009)).toBe(true);
    expect(isTrailingTransportError(31206)).toBe(true);
    expect(isTrailingTransportError(31401)).toBe(false);
    expect(isTrailingTransportError(20104)).toBe(false);
    expect(isTrailingTransportError(undefined)).toBe(false);
  });
});

describe("webrtcBlocked", () => {
  const stub = (pc: unknown) => {
    class Fake {}
    Object.assign(Fake.prototype, pc);
    Object.defineProperty(Fake.prototype, "iceGatheringState", { get: () => (pc as any).iceGatheringState });
    vi.stubGlobal("RTCPeerConnection", Fake);
  };
  afterEach(() => vi.unstubAllGlobals());

  it("is true only when gathering finds nothing even with TURN", async () => {
    stub(fakePc([]));
    expect(await webrtcBlocked(TWILIO_SERVERS)).toBe(true);
    stub(fakePc(["candidate:2 1 udp 1686052607 203.0.113.7 50000 typ srflx"]));
    expect(await webrtcBlocked(TWILIO_SERVERS)).toBe(false);
  });

  it("lets the call go ahead without servers or without WebRTC", async () => {
    stub(fakePc([]));
    expect(await webrtcBlocked(null)).toBe(false);
    vi.stubGlobal("RTCPeerConnection", undefined);
    expect(await webrtcBlocked(TWILIO_SERVERS)).toBe(false);
  });
});
