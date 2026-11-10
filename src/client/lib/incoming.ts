/**
 * Waiting inbound calls in the browser. Every inbound call waits in a Twilio queue of its own. The Worker
 * tells open screens with a live `incoming` event and lists the waiting calls at /api/routing/incoming.
 * Answering places a call from this device that names the waiting call (AnswerCallId), and the Worker checks
 * it and connects the two. The network and audio helpers live here, the pure rules in incoming-state.ts.
 */
import { type IncomingCallInfo, incomingCallTag } from "../../contracts/routing";
import { api } from "./api";
import { RING_CYCLE_SECONDS, ringSchedule } from "./incoming-state";

export * from "./incoming-state";

export const fetchIncoming = async () =>
  (await api<{ items: IncomingCallInfo[] }>("/api/routing/incoming")).items;

export const declineIncoming = (callId: string) =>
  api(`/api/routing/incoming/${encodeURIComponent(callId)}/decline`, { method: "POST" });

/** Closes this call's ringing notice, if the service worker showed one. Never throws. */
export async function closeIncomingNotice(callId: string): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    const reg = await navigator.serviceWorker.getRegistration();
    for (const n of (await reg?.getNotifications({ tag: incomingCallTag(callId) })) ?? []) n.close();
  } catch {
    // Notifications are a courtesy here: the call itself is unaffected.
  }
}

/**
 * Plays a ringtone through Web Audio until the returned stop is called. The Voice SDK's own ringtone only
 * plays for calls that ring the device directly, and waiting calls do not. A browser that blocks audio
 * before the first tap stays silent, and the sheet and the notice still show.
 */
export function startRingtone(): () => void {
  const Ctx =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!Ctx) return () => {};
  let ctx: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    ctx = new Ctx();
    const audio = ctx;
    const gain = audio.createGain();
    gain.gain.value = 0;
    gain.connect(audio.destination);
    for (const hz of [440, 480]) {
      const osc = audio.createOscillator();
      osc.frequency.value = hz;
      osc.connect(gain);
      osc.start();
    }
    // Schedules a minute of rings at a time, well past any ring time.
    const schedule = () => {
      for (const { on, off } of ringSchedule(audio.currentTime + 0.05, Math.ceil(60 / RING_CYCLE_SECONDS))) {
        gain.gain.setValueAtTime(0.15, on);
        gain.gain.setValueAtTime(0, off);
      }
    };
    schedule();
    void audio.resume().catch(() => undefined);
    timer = setInterval(() => {
      gain.gain.cancelScheduledValues(audio.currentTime);
      gain.gain.setValueAtTime(0, audio.currentTime);
      schedule();
    }, 60_000);
  } catch {
    // No audio: the sheet still shows.
  }
  return () => {
    clearInterval(timer);
    void ctx?.close().catch(() => undefined);
    ctx = null;
  };
}
