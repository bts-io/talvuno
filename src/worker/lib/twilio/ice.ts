/**
 * ICE servers for the browser's WebRTC connection, from Twilio's Network Traversal Service
 * (POST /Accounts/{sid}/Tokens.json): Twilio STUN plus TURN with short-lived credentials.
 *
 * Why: some browsers hide their local (host) ICE candidates (a WebRTC IP handling policy, a privacy
 * extension, an enterprise setting). With no ICE servers such a browser gathers nothing at all, and the
 * Voice SDK loops on ICE restarts. A STUN server gives it a server-reflexive candidate, TURN a relay.
 *
 * The answer is cached per isolate for CACHE_SECONDS (less REFRESH_MARGIN_SECONDS), so a busy app asks
 * Twilio about once an hour. When Twilio cannot be asked, the public Twilio STUN server is returned
 * (not cached) so calling still has a chance. The TURN credentials are never logged.
 */
import { TwilioApiError, twilioRest } from "./rest";

/**
 * How long the TURN credentials asked of Twilio stay valid: 4 hours, well past the 1 hour cache, so a call
 * that starts on a copy near the end of the cache keeps valid credentials for its ICE restarts.
 */
export const ICE_TTL_SECONDS = 4 * 60 * 60;
/** How long one answer is served from the cache. */
export const CACHE_SECONDS = 60 * 60;
/** How long the Worker waits for Twilio before it falls back to the public STUN server. */
export const NTS_TIMEOUT_MS = 4_000;
/** A cached answer is replaced this long before it expires, so a browser never gets one about to lapse. */
export const REFRESH_MARGIN_SECONDS = 5 * 60;
/** How long a browser may keep the fallback before asking again. */
export const FALLBACK_TTL_SECONDS = 5 * 60;

export const FALLBACK_ICE_SERVERS: IceServer[] = [{ urls: "stun:global.stun.twilio.com:3478" }];

export type IceServer = { urls: string; username?: string; credential?: string };
export type IceServers = {
  iceServers: IceServer[];
  /** Seconds the browser may use these for. */
  ttl: number;
  /** "twilio" when these came from the Network Traversal Service, "fallback" for the public STUN server. */
  source: "twilio" | "fallback";
};

type NtsToken = {
  ttl?: unknown;
  ice_servers?: Array<{ urls?: unknown; url?: unknown; username?: unknown; credential?: unknown }>;
};

let cached: { accountSid: string; iceServers: IceServer[]; expiresAt: number } | null = null;
let pending: Promise<IceServers> | null = null;

/** Test hook: forget the cached answer. */
export function resetIceServerCache(): void {
  cached = null;
  pending = null;
}

function parse(token: NtsToken): IceServer[] {
  const out: IceServer[] = [];
  for (const s of token.ice_servers ?? []) {
    const urls = typeof s.urls === "string" ? s.urls : typeof s.url === "string" ? s.url : null;
    if (!urls || !/^(stun|stuns|turn|turns):/.test(urls)) continue;
    const server: IceServer = { urls };
    if (typeof s.username === "string") server.username = s.username;
    if (typeof s.credential === "string") server.credential = s.credential;
    out.push(server);
  }
  return out;
}

async function fetchFromTwilio(env: Env, accountSid: string, now: number): Promise<IceServers> {
  const token = await twilioRest(env).post<NtsToken>(
    "/Tokens.json",
    { Ttl: ICE_TTL_SECONDS },
    { signal: AbortSignal.timeout(NTS_TIMEOUT_MS) },
  );
  const iceServers = parse(token);
  if (!iceServers.length) throw new Error("Twilio returned no usable ICE servers");
  // Served for at most CACHE_SECONDS, never longer than Twilio says the credentials last.
  const twilioTtl = Number(token.ttl) > 0 ? Number(token.ttl) : ICE_TTL_SECONDS;
  const lifetime = Math.min(twilioTtl, CACHE_SECONDS);
  cached = { accountSid, iceServers, expiresAt: now + lifetime * 1000 };
  return { iceServers, ttl: lifetime - REFRESH_MARGIN_SECONDS, source: "twilio" };
}

/** The ICE servers a browser should use now. Never throws. */
export async function getIceServers(env: Env, now: number = Date.now()): Promise<IceServers> {
  const accountSid = env.TWILIO_ACCOUNT_SID ?? "";
  if (cached && cached.accountSid === accountSid) {
    const left = Math.floor((cached.expiresAt - now) / 1000) - REFRESH_MARGIN_SECONDS;
    if (left > 0) return { iceServers: cached.iceServers, ttl: left, source: "twilio" };
  }
  pending ??= fetchFromTwilio(env, accountSid, now).finally(() => {
    pending = null;
  });
  try {
    return await pending;
  } catch (err) {
    // Only the status and Twilio's code: the request and response carry credentials.
    const detail =
      err instanceof TwilioApiError
        ? `status ${err.status}, code ${err.code ?? "none"}`
        : ((err as Error)?.name ?? "error");
    console.warn(`ice-servers: Twilio Network Traversal Service failed (${detail}); using public STUN`);
    return { iceServers: FALLBACK_ICE_SERVERS, ttl: FALLBACK_TTL_SECONDS, source: "fallback" };
  }
}
