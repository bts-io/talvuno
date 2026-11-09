/**
 * The only door to @twilio/voice-sdk. The SDK needs WebRTC and AudioContext, so it must never load during
 * SSR or in the Worker. Import it through `loadVoiceSdk()` from an effect or an event handler, never with a
 * static import. tests/unit/voice-sdk-boundary.test.ts fails the build if any other file imports the SDK, and
 * vite.config.ts swaps it for a throwing stub in the server build as a second guard.
 */
type VoiceSdk = typeof import("@twilio/voice-sdk");

let pending: Promise<VoiceSdk> | null = null;

export function loadVoiceSdk(): Promise<VoiceSdk> {
  if (typeof window === "undefined")
    return Promise.reject(new Error("@twilio/voice-sdk is browser only; call loadVoiceSdk from an effect"));
  pending ??= import("@twilio/voice-sdk");
  return pending;
}

/** SDK types for the rest of the app, so no other file has to name the package. Types only, erased at build. */
export type VoiceDevice = InstanceType<VoiceSdk["Device"]>;
export type VoiceCall = InstanceType<VoiceSdk["Call"]>;
export type VoiceError = { code?: number; message?: string; name?: string };
