// Talvuno service worker: installability, an offline fallback page, push notices.
//
// What it caches: the app shell files below (precached) and the hashed build files under /assets/ (cached on
// first use). It never caches /api/*, and it never stores page HTML: every page is private and live, so a
// page request always goes to the network and only falls back to /offline.html when the network is gone.
//
// Web Push cannot wake a suspended browser into a ringing call. Push is for missed-call and new-message
// notices only; see the README's platform limitations.

// Replaced with the build id when the client bundle is built (vite.config.ts), so every deploy changes this
// file and the browser installs the new worker. In `vite dev` the placeholder stays as it is.
const VERSION = "__BUILD_ID__";
const CACHE = `talvuno-${VERSION}`;
const PRECACHE = [
  "/offline.html",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/apple-touch-icon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];
const ICON = "/icons/icon-192.png";

self.addEventListener("install", (event) => {
  // No skipWaiting here: a new worker waits until the person accepts the "new version" toast, so the page
  // they are using is never swapped under them. The first install has nothing to wait for.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith("talvuno-") && n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match("/offline.html")) || Response.error()),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/") || PRECACHE.includes(url.pathname)) {
    event.respondWith(
      (async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
        }
        return res;
      })(),
    );
  }
});

// iOS and Chrome both require every push to show a notification, so this always shows one.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Talvuno";
  const tag = typeof data.tag === "string" && data.tag ? data.tag : undefined;
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      icon: ICON,
      // The same tag replaces the older notice; renotify makes the replacement alert again.
      tag,
      renotify: Boolean(tag),
      data: { url: typeof data.url === "string" ? data.url : "/" },
    }),
  );
});

// Only same-origin targets are followed, whatever the payload says.
function targetUrl(raw) {
  try {
    const url = new URL(raw || "/", self.location.origin);
    return url.origin === self.location.origin ? url.href : new URL("/", self.location.origin).href;
  } catch {
    return new URL("/", self.location.origin).href;
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = targetUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        if (open.url !== target && "navigate" in open) await open.navigate(target).catch(() => undefined);
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});

function base64UrlToBytes(value) {
  const padded = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// The browser dropped or rotated the subscription: make a new one and tell the server.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      let key = event.oldSubscription && event.oldSubscription.options.applicationServerKey;
      if (!key) {
        // Some browsers do not hand over the old subscription: ask the server for the VAPID key.
        const res = await fetch("/api/push/vapid-public-key", { credentials: "same-origin" });
        if (!res.ok) return;
        const body = await res.json();
        if (!body.publicKey) return;
        key = base64UrlToBytes(body.publicKey);
      }
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      await fetch("/api/push/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(sub.toJSON()),
      });
    })(),
  );
});
