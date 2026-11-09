export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * On the server (SSR loaders) requests go straight into the Hono app in-process via the bridge installed by
 * src/server.ts, with the browser's cookies; in the browser they are ordinary same-origin fetches.
 */
type Bridge = (path: string, init?: RequestInit) => Promise<Response>;
const transport = (path: string, init: RequestInit): Promise<Response> => {
  if (typeof window === "undefined") {
    const bridge = (globalThis as typeof globalThis & { __apiBridge?: Bridge }).__apiBridge;
    if (!bridge) throw new Error("API bridge not installed");
    return bridge(path, init);
  }
  return fetch(new URL(path, window.location.origin), { credentials: "same-origin", ...init });
};

/** Calls the Talvuno API. Throws ApiError with the server's `{ error, message }` on any non-2xx answer. */
export async function api<T = unknown>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await transport(path, { ...init, headers, body });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, err.error ?? "http_error", err.message ?? res.statusText);
  }
  return (await res.json()) as T;
}
