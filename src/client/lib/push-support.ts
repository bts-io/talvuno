/** Pure decisions about notifications support. No DOM types here, so Node-side tests can import it. */

/**
 * Where this browser stands on notifications and installing the app.
 *  - unsupported: no service worker, Push API or Notification API (or an insecure page).
 *  - needs-install: iOS and iPadOS only allow Web Push for an app added to the Home Screen.
 *  - ready: permission can be asked for or is already decided.
 */
export type PushSupport = "unsupported" | "needs-install" | "ready";

export type PlatformInfo = {
  ios: boolean;
  standalone: boolean;
  hasPush: boolean;
};

/** Pure so it can be tested: the decision from what the browser reports. */
export function pushSupport({ ios, standalone, hasPush }: PlatformInfo): PushSupport {
  if (ios && !standalone) return "needs-install";
  return hasPush ? "ready" : "unsupported";
}

export function isIos(userAgent: string, maxTouchPoints = 0): boolean {
  // iPadOS 13+ reports a Mac user agent; touch points tell it apart from a real Mac.
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/** The VAPID public key is base64url; `subscribe` wants bytes. */
export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
