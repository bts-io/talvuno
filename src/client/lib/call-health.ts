/**
 * Keeps a call honest when its media or signaling cannot recover. No SDK import here: the call, the device and
 * the peer connection come in as small interfaces, so these run in unit tests with fakes.
 *
 * Why this exists: when the browser gathers no ICE candidates at all (it hides its local candidates and was
 * given no STUN or TURN server, or a network that blocks WebRTC entirely), the Voice SDK treats every finished gathering as a failed ICE cycle and restarts ICE with
 * a backoff that starts at 1 ms (call.ts BACKOFF_CONFIG, min 1, factor 1.1, give up after 30 s). Each restart
 * sends a `reinvite` over the signaling socket. Twilio's gateway answers the burst with 31206 RateExceededError
 * and closes the socket, and every later reinvite fails with 31009 TransportError until the SDK gives up and
 * drops the call with 31003 ("connection dropped"). Meanwhile the far phone keeps ringing.
 */
import type { IceConfiguration, IceServer } from "./ice-servers";

/** How long a call may stay in "reconnecting" before the app ends it. The SDK alone waits 30 s. */
export const RECONNECT_GIVE_UP_MS = 10_000;

/** 31009 errors (nothing could be sent to Twilio) tolerated while reconnecting before the call is ended. */
export const MAX_TRANSPORT_ERRORS = 3;

/** Twilio's gateway refused the request rate: the signaling socket is going away. */
const RATE_EXCEEDED = 31206;
/** No transport available to send or receive messages. */
const NO_TRANSPORT = 31009;

/**
 * Device errors the SDK keeps emitting after the app ended a call (it cannot send its remaining messages).
 * Only these are hidden after an app-ended call; any other device error is a new problem and shows.
 */
export function isTrailingTransportError(code: number | undefined): boolean {
  return code === RATE_EXCEEDED || code === NO_TRANSPORT;
}

/** Every call event the supervisor follows is read without its arguments. */
type Listener = () => void;

/** The part of an SDK Call the supervisor needs. */
export type SupervisedCall = {
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
  disconnect(): void;
};

/** The part of an SDK Device the supervisor needs: its `error` events carry signaling failures. */
export type ErrorSource = {
  on(event: "error", listener: (err: { code?: number } | undefined) => void): unknown;
  removeListener(event: "error", listener: (err: { code?: number } | undefined) => void): unknown;
};

export type Timers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
};

/**
 * Why the app ended a call, as an en.json key under voice.errors: "media" when the audio path never came up
 * (the call was not answered yet), "network" when an answered call lost its connection.
 */
export type GiveUpKey = "media" | "network";

/**
 * Watches one call. When it stays in "reconnecting" longer than RECONNECT_GIVE_UP_MS, or while reconnecting
 * Twilio refuses the request rate (31206) or nothing can be sent any more (MAX_TRANSPORT_ERRORS times 31009),
 * it disconnects the call once and reports why. A "reconnected" call starts over. Returns a function that stops
 * watching; it also stops by itself when the call ends.
 */
export function superviseCall(
  call: SupervisedCall,
  device: ErrorSource,
  onGiveUp: (key: GiveUpKey) => void,
  timers: Timers = realTimers,
): () => void {
  let answered = false;
  let reconnecting = false;
  let transportErrors = 0;
  let timer: unknown = null;
  let done = false;

  const clearTimer = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };

  const giveUp = () => {
    if (done) return;
    const key: GiveUpKey = answered ? "network" : "media";
    stop();
    call.disconnect();
    onGiveUp(key);
  };

  const onAccept = () => {
    answered = true;
  };
  const onReconnecting = () => {
    if (reconnecting) return;
    reconnecting = true;
    transportErrors = 0;
    timer = timers.setTimeout(giveUp, RECONNECT_GIVE_UP_MS);
  };
  const onReconnected = () => {
    reconnecting = false;
    transportErrors = 0;
    clearTimer();
  };
  const onDeviceError = (err: { code?: number } | undefined) => {
    if (!reconnecting) return;
    if (err?.code === RATE_EXCEEDED) return giveUp();
    if (err?.code === NO_TRANSPORT && ++transportErrors >= MAX_TRANSPORT_ERRORS) giveUp();
  };
  const onEnd = () => stop();

  const callEvents: Array<[string, Listener]> = [
    ["accept", onAccept],
    ["reconnecting", onReconnecting],
    ["reconnected", onReconnected],
    ["disconnect", onEnd],
    ["cancel", onEnd],
    ["reject", onEnd],
  ];

  function stop() {
    if (done) return;
    done = true;
    clearTimer();
    for (const [event, listener] of callEvents) call.removeListener(event, listener);
    device.removeListener("error", onDeviceError);
  }

  for (const [event, listener] of callEvents) call.on(event, listener);
  device.on("error", onDeviceError);
  return stop;
}

/** The part of RTCPeerConnection the ICE probe needs. */
export type ProbePeerConnection = {
  addEventListener(type: "icecandidate", listener: (event: { candidate: unknown }) => void): void;
  addEventListener(type: "icegatheringstatechange", listener: () => void): void;
  readonly iceGatheringState: string;
  createDataChannel(label: string): unknown;
  createOffer(): Promise<unknown>;
  setLocalDescription(description: never): Promise<void>;
  close(): void;
};

/** Gathering usually ends within milliseconds when it finds nothing; a slow network gets this long. */
export const ICE_PROBE_TIMEOUT_MS = 3_000;

/** Whether a list of ICE servers has a TURN server, the last resort when nothing else gathers a candidate. */
export function hasTurn(servers: readonly IceServer[]): boolean {
  return servers.some((s) =>
    (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u: string) => /^turns?:/.test(u)),
  );
}

/**
 * Before a call: can this browser gather any ICE candidate with the ICE servers the call will use? Some
 * browsers hide their local (host) candidates, so with no servers they gather nothing; a STUN server still
 * gives them a server-reflexive candidate and TURN a relay one.
 *
 * "blocked" only when gathering finished with none even though TURN was offered: that call can never carry
 * audio, and the SDK would loop on ICE restarts. A first candidate is "ok" at once. No servers (they could not
 * be fetched), no TURN among them, a timeout or a browser error is "unknown": the call goes ahead and the
 * supervisor covers it.
 */
export async function probeIce(
  createPeerConnection: (config: IceConfiguration) => ProbePeerConnection,
  iceServers: IceServer[] | null,
  timers: Timers = realTimers,
): Promise<"ok" | "blocked" | "unknown"> {
  if (!iceServers?.length) return "unknown";
  const result = await gather(() => createPeerConnection({ iceServers }), timers);
  return result === "blocked" && !hasTurn(iceServers) ? "unknown" : result;
}

async function gather(
  createPeerConnection: () => ProbePeerConnection,
  timers: Timers,
): Promise<"ok" | "blocked" | "unknown"> {
  let pc: ProbePeerConnection;
  try {
    pc = createPeerConnection();
  } catch {
    return "unknown";
  }
  try {
    const result = await new Promise<"ok" | "blocked" | "unknown">((resolve) => {
      const timer = timers.setTimeout(() => resolve("unknown"), ICE_PROBE_TIMEOUT_MS);
      const finish = (r: "ok" | "blocked" | "unknown") => {
        timers.clearTimeout(timer);
        resolve(r);
      };
      pc.addEventListener("icecandidate", (event) => {
        // A null candidate marks the end of gathering; without a candidate before it, nothing was found.
        finish(event.candidate ? "ok" : "blocked");
      });
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") finish("blocked");
      });
      pc.createDataChannel("probe");
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer as never))
        .catch(() => finish("unknown"));
    });
    return result;
  } finally {
    pc.close();
  }
}
