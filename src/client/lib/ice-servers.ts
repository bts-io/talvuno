/**
 * The ICE servers every call uses, and the SDK options that carry them. No SDK import here, so these run in
 * unit tests and SSR.
 *
 * Voice SDK 2.18 has no ICE server option on the Device itself: the IceConfiguration goes with each call,
 * `device.connect({ rtcConfiguration })` for outgoing calls and `call.accept({ rtcConfiguration })` for
 * incoming ones (Device.ConnectOptions extends Call.AcceptOptions). The SDK keeps that configuration for the
 * call's ICE restarts.
 */
/** An IceServer, written out so this file needs no DOM types (unit tests compile without them). */
export type IceServer = { urls: string | string[]; username?: string; credential?: string };
/** The part of IceConfiguration a call sets. */
export type IceConfiguration = { iceServers: IceServer[] };

/** What GET /api/voice/ice-servers answers. */
export type IceServerAnswer = {
  iceServers: IceServer[];
  /** Seconds the browser may use these for. */
  ttl: number;
  source: "twilio" | "fallback";
};

/** Used when the app cannot ask the server: Twilio's public STUN server, no TURN. */
export const FALLBACK_ICE_SERVERS: IceServer[] = [{ urls: "stun:global.stun.twilio.com:3478" }];

/** A fetched answer is refreshed this long before the server said it lapses. */
const EXPIRY_MARGIN_MS = 30_000;
/**
 * How long past that point a copy is still handed out at once while a refresh runs. The server asks Twilio
 * for 4 hour TURN credentials and caches them for at most 1 hour, so a copy stays valid at least 3 hours past
 * its ttl; 2 hours keeps a wide margin. An older copy (a tab asleep for hours) waits for the fetch.
 */
export const STALE_GRACE_MS = 2 * 60 * 60 * 1000;

export type IceServerStore = {
  /**
   * The current servers. A lapsed copy still within STALE_GRACE_MS comes back at once while a refresh runs in
   * the background, so answering a call never waits on a fetch. Null when none could be fetched.
   */
  get(): Promise<IceServer[] | null>;
  /** Fetches new servers now (with the token refresh). Never throws. */
  refresh(): Promise<IceServer[] | null>;
};

export function createIceServerStore(
  fetchAnswer: () => Promise<IceServerAnswer>,
  now: () => number = Date.now,
): IceServerStore {
  let current: { servers: IceServer[]; expiresAt: number } | null = null;
  let pending: Promise<IceServer[] | null> | null = null;

  const refresh = () => {
    pending ??= fetchAnswer()
      .then((answer) => {
        if (!Array.isArray(answer?.iceServers) || !answer.iceServers.length) return null;
        current = {
          servers: answer.iceServers,
          expiresAt: now() + Math.max(0, answer.ttl * 1000 - EXPIRY_MARGIN_MS),
        };
        return current.servers;
      })
      .catch(() => null)
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  return {
    async get() {
      if (current && current.expiresAt > now()) return current.servers;
      if (current && current.expiresAt + STALE_GRACE_MS > now()) {
        void refresh();
        return current.servers;
      }
      return refresh();
    },
    refresh,
  };
}

/** The IceConfiguration for a call: the fetched servers, or the public STUN server when there are none. */
export function rtcConfigurationFor(servers: IceServer[] | null): IceConfiguration {
  return { iceServers: servers?.length ? servers : FALLBACK_ICE_SERVERS };
}

/** Options for `device.connect`: the TwiML params plus the ICE servers. */
export function connectOptions(params: Record<string, string>, servers: IceServer[] | null) {
  return { params, rtcConfiguration: rtcConfigurationFor(servers) };
}
