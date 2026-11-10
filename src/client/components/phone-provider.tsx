/**
 * The phone: one Twilio Voice Device for the signed-in app, plus the call screens that sit over every page
 * (incoming sheet, active call).
 *
 * Incoming calls never ring the device through Twilio. Every caller waits in a queue of its own (see
 * src/worker/lib/voice/routing.ts): open screens learn about it from a live `incoming` event, closed ones from
 * a push that opens /answer/<callId>. Answering places a call that names the waiting call, and the Worker checks
 * it and bridges the two. The first device to answer wins, the others stop ringing on the `ended` event.
 *
 * The SDK is only reached through loadVoiceSdk(), inside effects and handlers, never during SSR.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { IncomingCallInfo } from "../../contracts/routing";
import { isTrailingTransportError, probeIce, superviseCall } from "../lib/call-health";
import { connectOptions, createIceServerStore } from "../lib/ice-servers";
import {
  answerParams,
  applyIncomingEvent,
  closeIncomingNotice,
  declineIncoming,
  fetchIncoming,
  onIncoming,
  ringingCall,
  startRingtone,
} from "../lib/incoming";
import { onCallFailure, queryKeys } from "../lib/live";
import {
  callFailureKey,
  deviceSetupFailure,
  isOwnCallFailure,
  registerDevice,
  setupErrorKey,
  singleFlight,
  voiceErrorKey,
} from "../lib/voice";
import { fetchIceServers, fetchVoiceToken } from "../lib/voice-api";
import { loadVoiceSdk, type VoiceCall, type VoiceDevice, type VoiceError } from "../lib/voice-sdk";
import { ActiveCallScreen } from "./active-call";
import { IncomingCallSheet } from "./incoming-call-sheet";

export type DeviceState = "off" | "registering" | "ready" | "error";
export type CallState = "connecting" | "ringing" | "open" | "reconnecting";

export type ActiveCall = {
  direction: "inbound" | "outbound";
  party: string;
  name: string | null;
  state: CallState;
  /** When the call was answered (epoch ms), for the timer. */
  answeredAt: number | null;
  muted: boolean;
};

/** A call waiting for an answer. `numberId` is the number it came in on. */
export type IncomingCall = { callId: string; party: string; name: string | null; numberId: string | null };

export type MicResult = "ok" | "denied" | "unavailable";

type Phone = {
  deviceState: DeviceState;
  /** Getting a token or registering failed: calling is off until `retry` succeeds. */
  failed: boolean;
  /** Fetches a new token and registers again. */
  retry: () => void;
  /** An en.json key under voice.errors, or null. */
  error: string | null;
  /** Twilio's error code behind `error`, when Twilio reported one for a call that did not connect. */
  errorCode: number | null;
  clearError: () => void;
  /** A call is being placed (microphone, ICE probe, connect): a second tap does nothing. */
  placing: boolean;
  active: ActiveCall | null;
  incoming: IncomingCall | null;
  placeCall: (to: string, callerId: string | null, name?: string | null) => Promise<void>;
  accept: () => Promise<void>;
  /** Answers the waiting call with this id: the incoming sheet's Accept, and the push notice's route. */
  answer: (callId: string, info?: { party: string; name: string | null }) => Promise<void>;
  decline: () => void;
  hangUp: () => void;
  toggleMute: () => void;
  sendDigits: (digits: string) => void;
  requestMic: () => Promise<MicResult>;
};

const PhoneContext = createContext<Phone | null>(null);

export function usePhone(): Phone {
  const phone = useContext(PhoneContext);
  if (!phone) throw new Error("usePhone needs <PhoneProvider>");
  return phone;
}

/** Asks for the microphone once, then lets go of it; the SDK opens its own stream for the call. */
async function requestMic(): Promise<MicResult> {
  if (!navigator.mediaDevices?.getUserMedia) return "unavailable";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return "ok";
  } catch (err) {
    const name = (err as { name?: string }).name;
    return name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable";
  }
}

/** Seconds before the token expires that the SDK fires tokenWillExpire. */
const TOKEN_REFRESH_MS = 60_000;

export function PhoneProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const deviceRef = useRef<VoiceDevice | null>(null);
  const callRef = useRef<VoiceCall | null>(null);
  const [deviceState, setDeviceState] = useState<DeviceState>("off");
  const [error, setErrorKey] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<number | null>(null);
  const [active, setActive] = useState<ActiveCall | null>(null);
  const [waiting, setWaiting] = useState<IncomingCallInfo[]>([]);
  const [failed, setFailed] = useState(false);
  const [placing, setPlacing] = useState(false);
  /** Bumped by retry: the device effect runs again with a fresh token. */
  const [attempt, setAttempt] = useState(0);

  /**
   * The calls the app ended itself (the supervisor gave up on them). The SDK keeps reporting errors for such a
   * call, and trailing transport errors (31009 for every message it can no longer send) on the device; hiding
   * those keeps the app's reason from being replaced by a vaguer one. Nothing else is hidden: an error from
   * another call, or any other device error, shows. `appEndedLatest` is cleared by the next call or dismiss.
   */
  const appEnded = useRef(new WeakSet<VoiceCall>());
  const appEndedLatest = useRef(false);
  /** The CallSid of the call this tab placed last, once the SDK knows it. */
  const placedSid = useRef<string | null>(null);
  /** Twilio STUN and TURN servers for every call; refreshed with the token and whenever they lapse. */
  const iceStore = useRef(createIceServerStore(fetchIceServers)).current;

  /** The one place an error is set: an en.json key plus Twilio's code when Twilio reported one. */
  const setError = useCallback((key: string | null, code: number | null = null) => {
    setErrorKey(key);
    setErrorCode(code);
  }, []);

  const fail = useCallback(
    (err: VoiceError | unknown, call?: VoiceCall) => {
      const code = (err as VoiceError)?.code;
      if (call ? appEnded.current.has(call) : appEndedLatest.current && isTrailingTransportError(code))
        return;
      setError(voiceErrorKey((err as VoiceError)?.code));
    },
    [setError],
  );

  /** The token or the registration failed: calling is off, with a Retry, or a sign-in when the session ended. */
  const setupFailed = useCallback(
    (err: unknown) => {
      if (deviceSetupFailure(err) === "login") {
        void navigate({ to: "/login" });
        return;
      }
      setFailed(true);
      setDeviceState("off");
      setError(setupErrorKey((err as VoiceError)?.code));
    },
    [navigate, setError],
  );

  const refreshCalls = useCallback(() => {
    void qc.invalidateQueries({ queryKey: queryKeys.calls });
  }, [qc]);

  // Twilio says why a call did not connect (a blocked country, a bad number) in the dial result, which the
  // browser never sees. The Worker sends it in the live call event; show it as the call's error.
  useEffect(
    () =>
      onCallFailure((event) => {
        if (!event.errorCode) return;
        // Every open tab hears the event; only the tab that placed the call shows it.
        if (!isOwnCallFailure(event.callSid, placedSid.current)) return;
        // Twilio's reason is more precise than the supervisor's generic one, so it replaces it.
        setError(callFailureKey(event.errorCode), event.errorCode);
      }),
    [setError],
  );

  /** Follows one call's events into `active`, and clears it when the call ends. */
  const track = useCallback(
    (call: VoiceCall, base: Omit<ActiveCall, "state" | "answeredAt" | "muted">, state: CallState) => {
      callRef.current = call;
      setActive({ ...base, state, answeredAt: null, muted: false });
      const patch = (p: Partial<ActiveCall>) =>
        setActive((a) => (a && callRef.current === call ? { ...a, ...p } : a));
      // An outgoing call learns its CallSid once Twilio answers the signaling; keep it for the failure banner.
      const remember = () => {
        if (base.direction === "outbound" && callRef.current === call)
          placedSid.current = call.parameters?.CallSid ?? placedSid.current;
      };
      for (const event of ["ringing", "accept", "error", "disconnect", "cancel", "reject"])
        call.on(event, remember);
      remember();
      call.on("ringing", () => patch({ state: "ringing" }));
      call.on("accept", () => patch({ state: "open", answeredAt: Date.now() }));
      call.on("reconnecting", () => patch({ state: "reconnecting" }));
      call.on("reconnected", () => patch({ state: "open" }));
      call.on("mute", (muted: boolean) => patch({ muted }));
      call.on("error", (err: unknown) => fail(err, call));
      const device = deviceRef.current;
      if (device)
        superviseCall(call, device, (key) => {
          appEnded.current.add(call);
          appEndedLatest.current = true;
          setError(key);
        });
      const end = () => {
        if (callRef.current === call) {
          callRef.current = null;
          setActive(null);
        }
        refreshCalls();
      };
      call.on("disconnect", end);
      call.on("cancel", end);
      call.on("reject", end);
    },
    [fail, refreshCalls],
  );

  // attempt is the retry trigger: bumping it tears the device down and registers a new one.
  useEffect(() => {
    let cancelled = false;
    let device: VoiceDevice | null = null;
    setFailed(false);
    setDeviceState("registering");
    (async () => {
      try {
        // Fetched ahead so the first call does not wait for them; a failure here is retried at call time.
        void iceStore.get();
        const [{ Device, Call }, { token }] = await Promise.all([loadVoiceSdk(), fetchVoiceToken()]);
        if (cancelled) return;
        device = new Device(token, {
          codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
          // Twilio's automatic edge selection (the nearest edge, chosen by DNS).
          edge: "roaming",
          closeProtection: true,
          allowIncomingWhileBusy: false,
          tokenRefreshMs: TOKEN_REFRESH_MS,
          logLevel: "error",
        });
        deviceRef.current = device;
        device.on("registered", () => setDeviceState("ready"));
        device.on("registering", () => setDeviceState("registering"));
        device.on("unregistered", () => !cancelled && setDeviceState("off"));
        device.on("tokenWillExpire", async () => {
          void iceStore.refresh();
          try {
            const next = await fetchVoiceToken();
            if (!cancelled) device?.updateToken(next.token);
          } catch (err) {
            if (!cancelled) setupFailed(err);
          }
        });
        // An expired or refused token never recovers on its own: calling goes off, reported once.
        await registerDevice(
          device,
          (err) => !cancelled && setupFailed(err),
          (err) => {
            setDeviceState((s) => (s === "ready" ? s : "error"));
            fail(err);
          },
        );
      } catch (err) {
        if (cancelled) return;
        setupFailed(err);
      }
    })();
    return () => {
      cancelled = true;
      device?.destroy();
      deviceRef.current = null;
      callRef.current = null;
      setActive(null);
      setDeviceState("off");
    };
  }, [fail, refreshCalls, setupFailed, attempt, iceStore]);

  const retry = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, [setError]);

  const placeCallOnce = useCallback(
    async (to: string, callerId: string | null, name: string | null = null) => {
      const device = deviceRef.current;
      appEndedLatest.current = false;
      placedSid.current = null;
      setError(null);
      if (!device || callRef.current) return;
      const mic = await requestMic();
      if (mic !== "ok") {
        setError(mic === "denied" ? "micDenied" : "micUnavailable");
        return;
      }
      // The same STUN and TURN servers the call will use. A browser that gathers no ICE candidate even with
      // TURN can never carry audio: say so instead of ringing the far phone.
      const iceServers = await iceStore.get();
      if (
        typeof RTCPeerConnection !== "undefined" &&
        (await probeIce((config) => new RTCPeerConnection(config), iceServers)) === "blocked"
      ) {
        setError("webrtcBlocked");
        return;
      }
      try {
        const params: Record<string, string> = { To: to };
        if (callerId) params.CallerId = callerId;
        const call = await device.connect(connectOptions(params, iceServers));
        track(call, { direction: "outbound", party: to, name }, "connecting");
      } catch (err) {
        fail(err);
      }
    },
    [fail, track, setError, iceStore],
  );
  // requestMic and probeIce take up to a few seconds: a second tap in that time must not place a second call.
  const placeCall = useMemo(() => singleFlight(placeCallOnce, setPlacing), [placeCallOnce]);

  // The waiting calls: listed once on mount and whenever the tab comes back (events sent while it slept are
  // lost), then kept current by live events.
  useEffect(() => {
    let stopped = false;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      fetchIncoming()
        .then((items) => !stopped && setWaiting(items))
        .catch(() => undefined);
    };
    load();
    document.addEventListener("visibilitychange", load);
    const off = onIncoming((event) => {
      setWaiting((list) => applyIncomingEvent(list, event));
      if (event.state === "ended") {
        void closeIncomingNotice(event.callId);
        refreshCalls();
      }
    });
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", load);
      off();
    };
  }, [refreshCalls]);

  const ringing = ringingCall(waiting);
  const incoming = useMemo<IncomingCall | null>(
    () =>
      ringing
        ? {
            callId: ringing.callId,
            party: ringing.party,
            name: ringing.contactName,
            numberId: ringing.numberId,
          }
        : null,
    [ringing],
  );

  // The ringtone plays while the sheet shows. Waiting calls do not ring the device, so the SDK's sound never plays.
  const ringtoneFor = incoming && !active ? incoming.callId : null;
  useEffect(() => (ringtoneFor ? startRingtone() : undefined), [ringtoneFor]);

  const answerOnce = useCallback(
    async (callId: string, info?: { party: string; name: string | null }) => {
      const device = deviceRef.current;
      appEndedLatest.current = false;
      setError(null);
      if (callRef.current) return;
      if (!device) {
        setError("answerNeedsCalling");
        return;
      }
      const mic = await requestMic();
      if (mic !== "ok") {
        setError(mic === "denied" ? "micDenied" : "micUnavailable");
        return;
      }
      const iceServers = await iceStore.get();
      const known = waiting.find((c) => c.callId === callId);
      const party = info?.party ?? known?.party ?? "";
      const name = info?.name ?? known?.contactName ?? null;
      setWaiting((list) => list.filter((c) => c.callId !== callId));
      void closeIncomingNotice(callId);
      try {
        // The Worker answers this with the caller's queue, or a short refusal when another device was first.
        const call = await device.connect(connectOptions(answerParams(callId), iceServers));
        track(call, { direction: "inbound", party, name }, "connecting");
      } catch (err) {
        fail(err);
      }
    },
    [waiting, track, setError, iceStore, fail],
  );
  const answer = useMemo(() => singleFlight(answerOnce, setPlacing), [answerOnce]);

  const accept = useCallback(async () => {
    if (incoming) await answer(incoming.callId, { party: incoming.party, name: incoming.name });
  }, [incoming, answer]);

  const decline = useCallback(() => {
    if (!incoming) return;
    const { callId } = incoming;
    setWaiting((list) => list.filter((c) => c.callId !== callId));
    void closeIncomingNotice(callId);
    // Already answered elsewhere or gone: nothing to undo, the live event tidies up.
    declineIncoming(callId).catch(() => undefined);
  }, [incoming]);

  const value = useMemo<Phone>(
    () => ({
      deviceState,
      failed,
      retry,
      error,
      errorCode,
      placing,
      clearError: () => {
        appEndedLatest.current = false;
        setError(null);
      },
      active,
      incoming,
      placeCall,
      accept,
      answer,
      decline,
      hangUp: () => callRef.current?.disconnect(),
      toggleMute: () => {
        const call = callRef.current;
        if (call) call.mute(!call.isMuted());
      },
      sendDigits: (digits: string) => callRef.current?.sendDigits(digits),
      requestMic,
    }),
    [
      deviceState,
      failed,
      retry,
      error,
      errorCode,
      placing,
      active,
      incoming,
      placeCall,
      accept,
      answer,
      decline,
      setError,
    ],
  );

  return (
    <PhoneContext.Provider value={value}>
      {children}
      {incoming && !active ? <IncomingCallSheet /> : null}
      {active ? <ActiveCallScreen /> : null}
    </PhoneContext.Provider>
  );
}
