import type { VapidPublicKey } from "../../contracts/push";
import { api } from "./api";
import { isIos as isIosUa, type PlatformInfo, pushSupport, urlBase64ToUint8Array } from "./push-support";

export type { PlatformInfo, PushSupport } from "./push-support";
export { isIos, pushSupport, urlBase64ToUint8Array } from "./push-support";

export function readPlatform(): PlatformInfo {
  if (typeof window === "undefined" || typeof navigator === "undefined")
    return { ios: false, standalone: false, hasPush: false };
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const hasPush =
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  return { ios: isIosUa(navigator.userAgent, navigator.maxTouchPoints), standalone, hasPush };
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.ready;
}

/** This browser's current push subscription, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  return (await registration()).pushManager.getSubscription();
}

export class PushSetupError extends Error {
  constructor(public code: "denied" | "not_configured" | "unsupported") {
    super(code);
  }
}

/**
 * Asks for permission (must run from a click), subscribes this browser and tells the server. Throws
 * PushSetupError when the person says no or the deployment has no VAPID keys.
 */
export async function enablePush(): Promise<PushSubscription> {
  if (pushSupport(readPlatform()) !== "ready") throw new PushSetupError("unsupported");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new PushSetupError("denied");
  const { publicKey } = await api<VapidPublicKey>("/api/push/vapid-public-key");
  if (!publicKey) throw new PushSetupError("not_configured");
  const reg = await registration();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));
  await api("/api/push/subscriptions", { method: "POST", json: sub.toJSON() });
  return sub;
}

/** Removes this browser's subscription here and on the server. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api("/api/push/subscriptions", { method: "DELETE", json: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
}

export async function sendTestPush(): Promise<{ sent: number; removed: number; failed: number }> {
  return api("/api/push/test", { method: "POST", json: {} });
}
