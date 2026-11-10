import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { openUrlFromMessage } from "../../src/client/lib/open-url";

const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://talvuno.test";

type Handler = (event: any) => void;

/** Runs public/sw.js against a fake worker scope and returns the scope, its listeners and the fakes. */
function loadWorker(
  opts: {
    windows?: { url: string; focus?: any; navigate?: any; postMessage?: any }[];
    cached?: Record<string, Response>;
  } = {},
) {
  const listeners: Record<string, Handler> = {};
  const shown: { title: string; options: any }[] = [];
  const opened: string[] = [];
  const cache = new Map<string, Response>(Object.entries(opts.cached ?? {}));
  const puts: string[] = [];
  const deleted: string[] = [];
  const fakeFetch = vi.fn(
    async (_req: Request | string) => new Response("net", { status: 200 }) as Response & { req?: unknown },
  );

  const scope: any = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, h: Handler) => {
      listeners[type] = h;
    },
    registration: {
      showNotification: async (title: string, options: any) => void shown.push({ title, options }),
    },
    clients: {
      matchAll: async () => opts.windows ?? [],
      openWindow: async (url: string) => void opened.push(url),
      claim: async () => {},
    },
    skipWaiting: vi.fn(),
  };
  const subscribed: any[] = [];
  scope.registration.pushManager = {
    subscribe: async (options: any) => {
      subscribed.push(options);
      return {
        toJSON: () => ({ endpoint: "https://push.example.test/new", keys: { p256dh: "p", auth: "a" } }),
      };
    },
  };
  const context = vm.createContext({
    self: scope,
    URL,
    Response,
    Request,
    fetch: fakeFetch,
    atob,
    console,
    caches: {
      open: async () => ({
        addAll: async () => {},
        put: async (req: Request, res: Response) => {
          const path = new URL(req.url).pathname;
          puts.push(path);
          cache.set(path, res);
        },
      }),
      match: async (req: Request | string) =>
        cache.get(typeof req === "string" ? req : new URL(req.url).pathname),
      keys: async () => ["talvuno-old", "talvuno-__BUILD_ID__", "other-app"],
      delete: async (name: string) => void deleted.push(name),
    },
  });
  vm.runInContext(source, context);

  /** Fires an event and returns the promise handed to waitUntil / respondWith. */
  const fire = async (type: string, event: Record<string, unknown> = {}) => {
    const waits: Promise<unknown>[] = [];
    let responded: Promise<Response> | undefined;
    listeners[type]?.({
      ...event,
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      respondWith: (p: Promise<Response>) => (responded = p),
    });
    await Promise.all(waits);
    return { responded, handled: responded !== undefined };
  };
  return { scope, fire, subscribed, shown, opened, fakeFetch, puts, deleted, cache };
}

const pushEvent = (data: unknown) => ({
  data: { json: () => (typeof data === "string" ? JSON.parse(data) : data), text: () => String(data) },
});

describe("push handler", () => {
  it("shows the notification with icon, body and a tag that collapses repeats", async () => {
    const sw = loadWorker();
    await sw.fire(
      "push",
      pushEvent({ title: "Ann", body: "Are you there?", url: "/messages/1", tag: "conv-1" }),
    );
    expect(sw.shown).toEqual([
      {
        title: "Ann",
        options: {
          body: "Are you there?",
          icon: "/icons/icon-192.png",
          tag: "conv-1",
          renotify: true,
          data: { url: "/messages/1" },
        },
      },
    ]);
  });

  it("keeps a ringing call notice on screen and vibrates", async () => {
    const sw = loadWorker();
    await sw.fire(
      "push",
      pushEvent({
        title: "Incoming call",
        body: "Ada",
        url: "/answer/c1",
        tag: "call-CA1",
        requireInteraction: true,
      }),
    );
    expect(sw.shown[0]?.options).toMatchObject({
      tag: "call-CA1",
      requireInteraction: true,
      vibrate: [400, 200, 400, 200, 400],
      data: { url: "/answer/c1" },
    });
  });

  it("always shows something, even for an empty or broken payload", async () => {
    const sw = loadWorker();
    await sw.fire("push", { data: null });
    await sw.fire("push", {
      data: {
        json: () => {
          throw new Error("not json");
        },
        text: () => "plain words",
      },
    });
    expect(sw.shown.map((n) => [n.title, n.options.body, n.options.tag])).toEqual([
      ["Talvuno", "", undefined],
      ["Talvuno", "plain words", undefined],
    ]);
    expect(sw.shown[0]!.options.renotify).toBe(false);
  });
});

describe("notificationclick", () => {
  const click = (url: unknown) => ({ notification: { close: vi.fn(), data: { url } } });

  it("focuses an open Talvuno window and asks it to route, without reloading it", async () => {
    const focus = vi.fn(async () => {});
    const navigate = vi.fn(async () => {});
    const postMessage = vi.fn();
    const sw = loadWorker({ windows: [{ url: `${ORIGIN}/keypad`, focus, navigate, postMessage }] });
    const event = click("/messages/1");
    await sw.fire("notificationclick", event);
    expect(event.notification.close).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: "open-url", url: `${ORIGIN}/messages/1` });
    expect(navigate).not.toHaveBeenCalled();
    expect(sw.opened).toEqual([]);
  });

  it("opens the url when no window is open", async () => {
    const sw = loadWorker();
    await sw.fire("notificationclick", click("/recents"));
    expect(sw.opened).toEqual([`${ORIGIN}/recents`]);
  });

  it("never follows a link to another site", async () => {
    const sw = loadWorker();
    await sw.fire("notificationclick", click("https://evil.example/phish"));
    await sw.fire("notificationclick", click(undefined));
    expect(sw.opened).toEqual([`${ORIGIN}/`, `${ORIGIN}/`]);
  });
});

describe("fetch handler", () => {
  const req = (path: string, init: { method?: string; mode?: string; origin?: string } = {}) => ({
    request: {
      method: init.method ?? "GET",
      mode: init.mode ?? "no-cors",
      url: (init.origin ?? ORIGIN) + path,
    },
  });

  it("never touches /api/*, other methods or other origins", async () => {
    const sw = loadWorker();
    expect((await sw.fire("fetch", req("/api/me"))).handled).toBe(false);
    expect((await sw.fire("fetch", req("/api/live", { mode: "navigate" }))).handled).toBe(false);
    expect((await sw.fire("fetch", req("/assets/a.js", { method: "POST" }))).handled).toBe(false);
    expect((await sw.fire("fetch", req("/assets/a.js", { origin: "https://cdn.example" }))).handled).toBe(
      false,
    );
    expect(sw.puts).toEqual([]);
  });

  it("serves pages from the network and falls back to the offline page only", async () => {
    const offline = new Response("offline page");
    const sw = loadWorker({ cached: { "/offline.html": offline } });
    const online = await sw.fire("fetch", req("/messages", { mode: "navigate" }));
    expect(await (await online.responded!).text()).toBe("net");
    expect(sw.puts).toEqual([]); // private pages are never stored

    sw.fakeFetch.mockRejectedValueOnce(new TypeError("offline"));
    const down = await sw.fire("fetch", req("/messages", { mode: "navigate" }));
    expect(await (await down.responded!).text()).toBe("offline page");
  });

  it("caches hashed build files on first use and serves them from the cache after", async () => {
    const sw = loadWorker();
    const first = await sw.fire("fetch", req("/assets/app-abc.js"));
    expect(await (await first.responded!).text()).toBe("net");
    expect(sw.puts).toEqual(["/assets/app-abc.js"]);
    sw.fakeFetch.mockClear();
    const again = await sw.fire("fetch", req("/assets/app-abc.js"));
    expect(await (await again.responded!).text()).toBe("net");
    expect(sw.fakeFetch).not.toHaveBeenCalled();
  });
});

describe("lifecycle", () => {
  it("drops old Talvuno caches on activate but not other apps' caches", async () => {
    const sw = loadWorker();
    await sw.fire("activate");
    expect(sw.deleted).toEqual(["talvuno-old"]); // the current version cache and other apps stay
  });

  it("waits for the person before taking over, then skips waiting on request", async () => {
    const sw = loadWorker();
    await sw.fire("install");
    expect(sw.scope.skipWaiting).not.toHaveBeenCalled();
    await sw.fire("message", { data: { type: "SKIP_WAITING" } });
    expect(sw.scope.skipWaiting).toHaveBeenCalledOnce();
    await sw.fire("message", { data: { type: "other" } });
    expect(sw.scope.skipWaiting).toHaveBeenCalledOnce();
  });

  it("resubscribes with the server's VAPID key when the old subscription is missing", async () => {
    const w = loadWorker();
    w.fakeFetch.mockImplementation(async (req: any) =>
      String(req).endsWith("/vapid-public-key")
        ? (new Response(JSON.stringify({ publicKey: "AQID" }), { status: 200 }) as never)
        : (new Response(null, { status: 201 }) as never),
    );
    await w.fire("pushsubscriptionchange", { oldSubscription: null });
    expect(w.subscribed).toHaveLength(1);
    expect(Array.from(w.subscribed[0].applicationServerKey as Uint8Array)).toEqual([1, 2, 3]);
    const post = w.fakeFetch.mock.calls.find((c: any[]) => c[0] === "/api/push/subscriptions") as any[];
    expect(post[1].method).toBe("POST");
    expect(JSON.parse(post[1].body).endpoint).toBe("https://push.example.test/new");
  });

  it("does nothing when push is not configured on the server", async () => {
    const w = loadWorker();
    w.fakeFetch.mockImplementation(
      async () => new Response(JSON.stringify({ publicKey: null }), { status: 200 }) as never,
    );
    await w.fire("pushsubscriptionchange", {});
    expect(w.subscribed).toHaveLength(0);
  });
});

describe("openUrlFromMessage", () => {
  it("turns an open-url message into an in-app path", () => {
    expect(openUrlFromMessage({ type: "open-url", url: `${ORIGIN}/answer/c1?x=1` }, ORIGIN)).toBe(
      "/answer/c1?x=1",
    );
  });

  it("ignores other messages and other sites", () => {
    expect(openUrlFromMessage({ type: "other", url: `${ORIGIN}/a` }, ORIGIN)).toBeNull();
    expect(openUrlFromMessage({ type: "open-url", url: "https://evil.example/a" }, ORIGIN)).toBeNull();
    expect(openUrlFromMessage(null, ORIGIN)).toBeNull();
  });
});
