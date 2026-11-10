/**
 * Single Worker entry: the Hono API owns /api/*, every other request is server-rendered by TanStack Start.
 * Same shape as our other TanStack Start Workers. The OwnerHub Durable Object class is re-exported here so the
 * binding in wrangler.jsonc resolves.
 *
 * While a page renders, loaders call the API in-process through `globalThis.__apiBridge` (see
 * src/client/lib/api.ts): same Hono app, same env, the browser's cookies forwarded, no network hop.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import startHandler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { isWorkerOwned } from "./shared/build";
import { scheduled } from "./worker/cron";
import worker from "./worker/index";
import { applyCsp, newNonce } from "./worker/lib/csp";
import { handleTranscribeBatch } from "./worker/lib/voicemail";

export { OwnerHub } from "./worker/index";

const FORWARDED = ["cookie", "accept-language", "user-agent", "cf-connecting-ip"];

type RequestScope = {
  env: Env;
  ctx: ExecutionContext;
  request: Request;
  setCookies: string[];
  nonce: string;
};
const scope = new AsyncLocalStorage<RequestScope>();

type Bridge = (path: string, init?: RequestInit) => Promise<Response>;
type BridgeGlobal = typeof globalThis & {
  __apiBridge?: Bridge;
  __requestScope?: () => { cookie: string; acceptLanguage?: string; nonce?: string } | undefined;
};
const g = globalThis as BridgeGlobal;

g.__apiBridge = async (path, init) => {
  const s = scope.getStore();
  if (!s) throw new Error("API bridge used outside a request");
  const url = new URL(path, s.request.url);
  const headers = new Headers(init?.headers);
  for (const h of FORWARDED) {
    const v = s.request.headers.get(h);
    if (v && !headers.has(h)) headers.set(h, v);
  }
  const res = await worker.fetch(new Request(url, { ...init, headers }), s.env, s.ctx);
  for (const sc of res.headers.getSetCookie()) s.setCookies.push(sc);
  return res;
};
g.__requestScope = () => {
  const s = scope.getStore();
  return s
    ? {
        cookie: s.request.headers.get("cookie") ?? "",
        acceptLanguage: s.request.headers.get("accept-language") ?? undefined,
        nonce: s.nonce,
      }
    : undefined;
};

/**
 * TanStack Start's createServerEntry hands its handler only `(request, requestOpts)`, so a Workers
 * `fetch(request, env, ctx)` written inside it sees env as requestOpts and ctx as undefined. Hono then throws
 * "This context has no ExecutionContext" on `c.executionCtx`. The Worker export below owns the real
 * signature and passes env and ctx on itself; the Start entry only renders pages inside the request scope.
 */
const pages = createServerEntry({
  fetch(request: Request) {
    return startHandler.fetch(request, { responseLinkHeader: true });
  },
});

async function fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (isWorkerOwned(pathname)) return worker.fetch(request, env, ctx);

  const s: RequestScope = { env, ctx, request, setCookies: [], nonce: newNonce() };
  const res = await scope.run(s, () => pages.fetch(request));
  const out = new Response(res.body, res);
  // Every page belongs to one signed-in person: never cached anywhere.
  if ((res.headers.get("content-type") ?? "").includes("text/html")) {
    out.headers.set("cache-control", "private, no-store");
    out.headers.set("x-content-type-options", "nosniff");
    out.headers.set("referrer-policy", "strict-origin-when-cross-origin");
    out.headers.set("x-frame-options", "DENY");
    applyCsp(out.headers, s.nonce, request.url, env.CSP_REPORT_ONLY);
  }
  // A session refreshed during SSR (Better Auth's updateAge) reaches the browser.
  // The API answers each bridged call with the same refreshed cookie; the last one per name wins.
  const latest = new Map<string, string>();
  for (const sc of s.setCookies) latest.set(sc.split("=")[0] ?? sc, sc);
  for (const sc of latest.values()) out.headers.append("set-cookie", sc);
  return out;
}

/** The TRANSCRIBE queue consumer (voicemail transcripts). */
const queue: ExportedHandlerQueueHandler<Env> = (batch, env) => handleTranscribeBatch(batch, env);

export default { fetch, scheduled, queue } satisfies ExportedHandler<Env>;
