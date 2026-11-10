/**
 * Waiting inbound calls in the browser. Every inbound call waits in a Twilio queue of its own; the Worker
 * tells open screens with a live `incoming` event and lists the waiting calls at /api/routing/incoming.
 * Answering places a call from this device that names the waiting call (AnswerCallId); the Worker checks it
 * and connects the two. Pure helpers here, the effects live in phone-provider.tsx.
 */
import type { LiveEvent } from "../../contracts";
import { type IncomingCallInfo, incomingCallTag } from "../../contracts/routing";
import { api } from "./api";

export type IncomingEvent = Extract<LiveEvent, { type: "incoming" }>;

/** The waiting calls after a live event: ringing adds or refreshes one, ended removes it. */
export function applyIncomingEvent(list: IncomingCallInfo[], event: IncomingEvent, now = Date.now()) {
  const rest = list.filter((c) => c.callId !== event.callId);
  if (event.state === "ended") return rest;
  return [
    {
      callId: event.callId,
      party: event.party ?? "",
      contactName: event.contactName ?? null,
      numberId: event.numberId ?? null,
      startedAt: now,
    },
    ...rest,
  ];
}

/** The call the incoming sheet shows: the newest still waiting. */
export const ringingCall = (list: IncomingCallInfo[]) => list[0] ?? null;

const listeners = new Set<(event: IncomingEvent) => void>();

/** Calls `listener` for every live incoming event. Returns the unsubscribe. */
export function onIncoming(listener: (event: IncomingEvent) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function announceIncoming(event: LiveEvent): void {
  if (event.type !== "incoming") return;
  for (const listener of listeners) listener(event);
}

export const fetchIncoming = async () =>
  (await api<{ items: IncomingCallInfo[] }>("/api/routing/incoming")).items;

export const declineIncoming = (callId: string) =>
  api(`/api/routing/incoming/${encodeURIComponent(callId)}/decline`, { method: "POST" });

/** The parameters a device sends to answer a waiting call instead of dialing. */
export const answerParams = (callId: string) => ({ AnswerCallId: callId });

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

/** One ringtone cycle in seconds: [tone on, silence] pairs, as a phone rings (two short rings, a pause). */
export const RING_PATTERN: readonly [number, number][] = [
  [0.4, 0.2],
  [0.4, 2.0],
];
export const RING_CYCLE_SECONDS = RING_PATTERN.reduce((s, [on, off]) => s + on + off, 0);

/** Start and stop times (seconds from `start`) of every tone in `cycles` ring cycles. */
export function ringSchedule(start: number, cycles: number): { on: number; off: number }[] {
  const out: { on: number; off: number }[] = [];
  let t = start;
  for (let i = 0; i < cycles; i++)
    for (const [on, off] of RING_PATTERN) {
      out.push({ on: t, off: t + on });
      t += on + off;
    }
  return out;
}

/**
 * Plays a ringtone through Web Audio until the returned stop is called. The Voice SDK's own ringtone only
 * plays for calls that ring the device directly, and waiting calls do not. A browser that blocks audio
 * before the first tap stays silent; the sheet and the notice still show.
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
