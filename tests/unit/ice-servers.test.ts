import { describe, expect, it, vi } from "vitest";
import {
  connectOptions,
  createIceServerStore,
  FALLBACK_ICE_SERVERS,
  type IceServer,
  type IceServerAnswer,
  STALE_GRACE_MS,
} from "../../src/client/lib/ice-servers";

const SERVERS: IceServer[] = [
  { urls: "stun:global.stun.twilio.com:3478" },
  { urls: "turn:global.turn.twilio.com:3478?transport=udp", username: "u", credential: "c" },
];
const answer = (ttl = 3300): IceServerAnswer => ({ iceServers: SERVERS, ttl, source: "twilio" });

describe("createIceServerStore", () => {
  it("fetches once and reuses the answer until it lapses", async () => {
    let now = 1_000_000;
    const fetch = vi.fn(async () => answer(600));
    const store = createIceServerStore(fetch, () => now);
    expect(await store.get()).toEqual(SERVERS);
    expect(await store.get()).toEqual(SERVERS);
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 600_000 - 30_000 + 1;
    await store.get();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("hands out a lapsed copy at once while a refresh runs in the background", async () => {
    let now = 1_000_000;
    const fresh: IceServer[] = [{ urls: "stun:fresh.example:3478" }];
    let release: (a: IceServerAnswer) => void = () => {};
    const fetch = vi
      .fn<() => Promise<IceServerAnswer>>()
      .mockResolvedValueOnce(answer(600))
      .mockImplementationOnce(() => new Promise((r) => (release = r)));
    const store = createIceServerStore(fetch, () => now);
    await store.get();
    now += 600_000;
    expect(await store.get()).toEqual(SERVERS);
    expect(fetch).toHaveBeenCalledTimes(2);
    release({ iceServers: fresh, ttl: 600, source: "twilio" });
    await Promise.resolve();
    await Promise.resolve();
    expect(await store.get()).toEqual(fresh);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("waits for a fetch when the copy is older than the grace period", async () => {
    let now = 1_000_000;
    const fetch = vi
      .fn<() => Promise<IceServerAnswer>>()
      .mockResolvedValueOnce(answer(600))
      .mockRejectedValueOnce(new Error("offline"));
    const store = createIceServerStore(fetch, () => now);
    await store.get();
    now += 600_000 + STALE_GRACE_MS;
    expect(await store.get()).toBeNull();
  });

  it("shares one request between concurrent callers", async () => {
    const fetch = vi.fn(async () => answer());
    const store = createIceServerStore(fetch);
    await Promise.all([store.get(), store.get(), store.refresh()]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refresh fetches even while the answer is still good", async () => {
    const fetch = vi.fn(async () => answer());
    const store = createIceServerStore(fetch);
    await store.get();
    await store.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("answers null when the fetch fails, and tries again next time", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(answer());
    const store = createIceServerStore(fetch);
    expect(await store.get()).toBeNull();
    expect(await store.get()).toEqual(SERVERS);
  });

  it("answers null for an empty server list", async () => {
    const store = createIceServerStore(async () => ({ iceServers: [], ttl: 300, source: "fallback" }));
    expect(await store.get()).toBeNull();
  });
});

describe("call options", () => {
  it("places an outgoing call with the params and the ICE servers", () => {
    expect(connectOptions({ To: "+14155552671" }, SERVERS)).toEqual({
      params: { To: "+14155552671" },
      rtcConfiguration: { iceServers: SERVERS },
    });
  });

  it("falls back to Twilio's public STUN server when none could be fetched", () => {
    expect(connectOptions({}, null)).toEqual({
      params: {},
      rtcConfiguration: { iceServers: [{ urls: "stun:global.stun.twilio.com:3478" }] },
    });
    expect(connectOptions({}, [])).toMatchObject({ rtcConfiguration: { iceServers: FALLBACK_ICE_SERVERS } });
  });
});

describe("phone provider wiring", () => {
  it("places and answers every call with the ICE server options", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../../src/client/components/phone-provider.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toContain("device.connect(connectOptions(params, iceServers))");
    // Waiting calls are answered by a call of our own that names them, with the same ICE servers.
    expect(src).toContain("device.connect(connectOptions(answerParams(callId), iceServers))");
    expect(src).toContain("probeIce((config) => new RTCPeerConnection(config), iceServers)");
    expect(src).not.toMatch(/\.accept\(\)/);
  });
});
