/**
 * Registers /sw.js (offline fallback page, push) and tracks updates. A new worker installs in the
 * background and then waits: the app shows a "new version available" toast, and only when the person taps
 * it does the waiting worker take over and the page reload. Not registered in `vite dev`, where a worker would
 * only get in the way of hot reload.
 */
type Listener = (waiting: ServiceWorker | null) => void;

let waitingWorker: ServiceWorker | null = null;
const listeners = new Set<Listener>();

function setWaiting(worker: ServiceWorker | null) {
  waitingWorker = worker;
  for (const l of listeners) l(worker);
}

/** Calls `listener` now and on every change with the worker that is waiting to take over, or null. */
export function onUpdateReady(listener: Listener): () => void {
  listeners.add(listener);
  listener(waitingWorker);
  return () => {
    listeners.delete(listener);
  };
}

/** Tells the waiting worker to take over. The page reloads once the new worker controls it. */
export function applyUpdate(): void {
  waitingWorker?.postMessage({ type: "SKIP_WAITING" });
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (import.meta.env.DEV || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });

    // A worker installed in an earlier visit may already be waiting.
    if (reg.waiting && navigator.serviceWorker.controller) setWaiting(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const installing = reg.installing;
      installing?.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) setWaiting(installing);
      });
    });

    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // Only reload for an update the person accepted, not for the very first claim.
      if (reloaded || !waitingWorker) return;
      reloaded = true;
      window.location.reload();
    });

    // Look for a new version when the app comes back to the foreground.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void reg.update().catch(() => undefined);
    });
    return reg;
  } catch (err) {
    console.warn("service worker registration failed", err);
    return null;
  }
}

/** The in-app path a worker "open-url" message asks for. Same-origin only, anything else is ignored. */
export function openUrlFromMessage(data: unknown, origin: string): string | null {
  if (!data || typeof data !== "object") return null;
  const { type, url } = data as { type?: unknown; url?: unknown };
  if (type !== "open-url" || typeof url !== "string") return null;
  try {
    const parsed = new URL(url, origin);
    return parsed.origin === origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : null;
  } catch {
    return null;
  }
}
