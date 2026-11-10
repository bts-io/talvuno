/**
 * Minimal Twilio REST client for the Worker: form-encoded requests against
 * `${TWILIO_API_BASE ?? "https://api.twilio.com"}/2010-04-01/Accounts/{sid}/...` with API key Basic auth.
 * The account auth token is never used here; it only checks webhook signatures.
 */

const DEFAULT_BASE = "https://api.twilio.com";

/** A non-2xx answer from Twilio. `code` is Twilio's error code (for example 21211), when it sent one. */
export class TwilioApiError extends Error {
  constructor(
    public status: number,
    public code: number | null,
    message: string,
    public moreInfo: string | null,
  ) {
    super(message);
    this.name = "TwilioApiError";
  }
}

/** Twilio is not configured on this deployment (one of the account or API key values is missing). */
export class TwilioNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(`Twilio is not configured: ${missing.join(", ")} missing`);
    this.name = "TwilioNotConfiguredError";
  }
}

export type FormValue = string | number | boolean | undefined | null | readonly (string | number | boolean)[];
export type Form = Record<string, FormValue>;
export type Query = Record<string, string | number | boolean | undefined | null>;

export interface TwilioRest {
  /** Path relative to the account, for example "/IncomingPhoneNumbers.json". */
  get<T = unknown>(path: string, query?: Query): Promise<T>;
  /** `signal` aborts the request, for example `AbortSignal.timeout(ms)`. */
  post<T = unknown>(path: string, form?: Form, options?: { signal?: AbortSignal }): Promise<T>;
  /** DELETE on an account path. Twilio answers 204. */
  delete(path: string, options?: { signal?: AbortSignal }): Promise<void>;
  /** GET that returns the raw answer (recording audio, for example). Throws TwilioApiError on non-2xx. */
  media(path: string, options?: { signal?: AbortSignal }): Promise<Response>;
  /** The account SID requests run under. */
  accountSid: string;
}

function encodeForm(form: Form): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const v of value) body.append(key, String(v));
    else body.append(key, String(value));
  }
  return body.toString();
}

async function toError(res: Response): Promise<TwilioApiError> {
  let body: { code?: unknown; message?: unknown; more_info?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Not JSON (a proxy error page, for example); fall back to the status line.
  }
  return new TwilioApiError(
    res.status,
    typeof body.code === "number" ? body.code : null,
    typeof body.message === "string" ? body.message : `Twilio answered ${res.status}`,
    typeof body.more_info === "string" ? body.more_info : null,
  );
}

/** A client bound to this deployment's account. Throws TwilioNotConfiguredError when values are missing. */
export function twilioRest(env: Env): TwilioRest {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const keySid = env.TWILIO_API_KEY_SID;
  const keySecret = env.TWILIO_API_KEY_SECRET;
  const missing = [
    !accountSid && "TWILIO_ACCOUNT_SID",
    !keySid && "TWILIO_API_KEY_SID",
    !keySecret && "TWILIO_API_KEY_SECRET",
  ].filter((m): m is string => Boolean(m));
  if (missing.length || !accountSid || !keySid || !keySecret) throw new TwilioNotConfiguredError(missing);

  const root = `${(env.TWILIO_API_BASE ?? DEFAULT_BASE).replace(/\/+$/, "")}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}`;
  const authorization = `Basic ${btoa(`${keySid}:${keySecret}`)}`;
  const urlFor = (path: string) => `${root}${path.startsWith("/") ? path : `/${path}`}`;

  async function raw(url: string, init: RequestInit, accept: string): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", authorization);
    headers.set("accept", accept);
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) throw await toError(res);
    return res;
  }

  async function send<T>(url: string, init: RequestInit): Promise<T> {
    const res = await raw(url, init, "application/json");
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    accountSid,
    get<T>(path: string, query?: Query) {
      const url = new URL(urlFor(path));
      for (const [k, v] of Object.entries(query ?? {}))
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      return send<T>(url.toString(), { method: "GET" });
    },
    post<T>(path: string, form: Form = {}, options: { signal?: AbortSignal } = {}) {
      return send<T>(urlFor(path), {
        method: "POST",
        signal: options.signal,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: encodeForm(form),
      });
    },
    async delete(path: string, options: { signal?: AbortSignal } = {}) {
      const res = await raw(urlFor(path), { method: "DELETE", signal: options.signal }, "application/json");
      await res.body?.cancel();
    },
    media(path: string, options: { signal?: AbortSignal } = {}) {
      return raw(urlFor(path), { method: "GET", signal: options.signal }, "*/*");
    },
  };
}
