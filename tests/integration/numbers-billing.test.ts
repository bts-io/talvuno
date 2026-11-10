import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearBillingCache } from "../../src/worker/routes/billing";
import { BASE, createOwner, resetDb, Session } from "./helpers";

// Secrets are optional on Env; tests set and read them by name.
const vars = env as unknown as Record<string, string | undefined>;
const ACCOUNT = "/2010-04-01/Accounts/AC00000000000000000000000000000000";

interface FakeNumber {
  sid: string;
  phone_number: string;
  friendly_name: string;
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
  voice_url: string | null;
  voice_method: string | null;
  sms_url: string | null;
  sms_method: string | null;
  status_callback: string | null;
  status_callback_method: string | null;
  voice_application_sid: string | null;
}

const fake = (sid: string, e164: string, extra: Partial<FakeNumber> = {}): FakeNumber => ({
  sid,
  phone_number: e164,
  friendly_name: `Name ${e164}`,
  capabilities: { voice: true, sms: true, mms: false },
  voice_url: "https://old.example/voice",
  voice_method: "GET",
  sms_url: "https://old.example/sms",
  sms_method: "GET",
  status_callback: null,
  status_callback_method: null,
  voice_application_sid: "APold0000000000000000000000000000",
  ...extra,
});

// A tiny in-memory Twilio. Every request the Worker makes lands in `calls`.
let twilioNumbers: FakeNumber[];
let calls: { method: string; url: URL; form: URLSearchParams }[];
let failWith: { status: number; code: number; message: string } | null;

function installTwilio() {
  twilioNumbers = [];
  calls = [];
  failWith = null;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://twilio.mock") throw new Error(`unexpected fetch ${url}`);
    const method = init?.method ?? "GET";
    const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    calls.push({ method, url, form });
    if (failWith)
      return Response.json({ code: failWith.code, message: failWith.message }, { status: failWith.status });
    const p = url.pathname;
    if (p === `${ACCOUNT}/IncomingPhoneNumbers.json`)
      return Response.json({ incoming_phone_numbers: twilioNumbers });
    const one = p.match(/\/IncomingPhoneNumbers\/(PN\w+)\.json$/);
    if (one) {
      const n = twilioNumbers.find((x) => x.sid === one[1]);
      if (!n) return Response.json({ code: 20404, message: "not found" }, { status: 404 });
      if (method === "POST") {
        const map: Record<string, keyof FakeNumber> = {
          VoiceUrl: "voice_url",
          VoiceMethod: "voice_method",
          SmsUrl: "sms_url",
          SmsMethod: "sms_method",
          StatusCallback: "status_callback",
          StatusCallbackMethod: "status_callback_method",
          VoiceApplicationSid: "voice_application_sid",
        };
        for (const [k, v] of form) (n as unknown as Record<string, unknown>)[map[k]!] = v === "" ? null : v;
      }
      return Response.json(n);
    }
    if (p === `${ACCOUNT}/Balance.json`) return Response.json({ balance: "12.3400", currency: "USD" });
    if (p === `${ACCOUNT}/Usage/Records/ThisMonth.json`) {
      const category = url.searchParams.get("Category");
      return Response.json({
        usage_records: [
          {
            category,
            count: "7",
            usage: "5",
            usage_unit: category === "calls" ? "minutes" : "messages",
            price: "0.42",
            price_unit: "usd",
            start_date: "2026-11-01",
            end_date: "2026-11-30",
          },
        ],
      });
    }
    // Standard API keys cannot read the account resource itself.
    if (p === "/2010-04-01/Accounts/AC00000000000000000000000000000000.json")
      return Response.json({ code: 20003, message: "Authenticate" }, { status: 401 });
    return new Response("unexpected", { status: 500 });
  });
}

let owner: Awaited<ReturnType<typeof createOwner>>;

beforeEach(async () => {
  await resetDb();
  await env.DB.prepare("DELETE FROM phone_numbers").run();
  clearBillingCache();
  installTwilio();
  owner = await createOwner();
});
afterEach(() => vi.restoreAllMocks());

const ours = () => ({
  voice: `${BASE}/api/twilio/voice/inbound`,
  sms: `${BASE}/api/twilio/sms/inbound`,
  status: `${BASE}/api/twilio/voice/status`,
});
const twilioCalls = () => calls.filter((c) => c.url.origin === "https://twilio.mock");

describe("auth", () => {
  it("keeps every new route behind the owner session", async () => {
    const anon = new Session();
    for (const path of ["/api/numbers", "/api/preferences", "/api/billing", "/api/status/config"])
      expect((await anon.fetch(path)).status, path).toBe(401);
    expect((await anon.fetch("/api/numbers/sync", { method: "POST" })).status).toBe(401);
  });
});

describe("POST /api/numbers/sync", () => {
  it("upserts by SID, keeps a custom name, and makes the first number the default", async () => {
    twilioNumbers = [fake("PN1", "+14155550101"), fake("PN2", "+14155550102")];
    const first = await owner.post("/api/numbers/sync");
    expect(first).toMatchObject({ added: 2, updated: 0, released: 0 });
    expect(first.numbers).toHaveLength(2);
    expect(first.numbers.filter((n: { isDefault: boolean }) => n.isDefault)).toHaveLength(1);
    expect(first.numbers[0]).toMatchObject({
      e164: "+14155550101",
      twilioSid: "PN1",
      isDefault: true,
      capabilities: { voice: true, sms: true, mms: false },
    });
    expect(twilioCalls()[0]!.url.searchParams.get("PageSize")).toBe("1000");

    await owner.json("PATCH", `/api/numbers/${first.numbers[0].id}`, { friendlyName: "Mine" });
    twilioNumbers[0]!.capabilities = { voice: true, sms: true, mms: true };
    twilioNumbers[0]!.friendly_name = "Renamed at Twilio";
    const again = await owner.post("/api/numbers/sync");
    expect(again).toMatchObject({ added: 0, updated: 2, released: 0 });
    expect(again.numbers).toHaveLength(2);
    expect(again.numbers[0]).toMatchObject({
      friendlyName: "Mine",
      capabilities: { mms: true },
    });
  });

  it("marks numbers Twilio no longer lists as released and moves the default", async () => {
    twilioNumbers = [fake("PN1", "+14155550101"), fake("PN2", "+14155550102")];
    await owner.post("/api/numbers/sync");
    twilioNumbers = [twilioNumbers[1]!];
    const out = await owner.post("/api/numbers/sync");
    expect(out.released).toBe(1);
    const gone = out.numbers.find((n: { twilioSid: string }) => n.twilioSid === "PN1");
    const kept = out.numbers.find((n: { twilioSid: string }) => n.twilioSid === "PN2");
    expect(gone.releasedAt).toBeTypeOf("number");
    expect(gone.isDefault).toBe(false);
    expect(kept).toMatchObject({ releasedAt: null, isDefault: true });
    const prefs = await owner.get("/api/preferences");
    expect(prefs.defaultNumberId).toBe(kept.id);

    // It comes back when Twilio lists it again; the row (and its history) is reused.
    twilioNumbers = [fake("PN1", "+14155550101"), fake("PN2", "+14155550102")];
    const back = await owner.post("/api/numbers/sync");
    expect(back.numbers.find((n: { twilioSid: string }) => n.twilioSid === "PN1").releasedAt).toBeNull();
  });

  it("keeps a number the owner removed removed through a sync, until Add back", async () => {
    twilioNumbers = [fake("PN1", "+14155550101"), fake("PN2", "+14155550102")];
    const { numbers: list } = await owner.post("/api/numbers/sync");
    const one = list.find((n: { twilioSid: string }) => n.twilioSid === "PN1");
    await owner.json("DELETE", `/api/numbers/${one.id}`);
    const synced = await owner.post("/api/numbers/sync");
    expect(synced.numbers.find((n: { id: string }) => n.id === one.id).releasedAt).toBeTypeOf("number");
    const back = await owner.post(`/api/numbers/${one.id}/restore-number`);
    expect(back.find((n: { id: string }) => n.id === one.id).releasedAt).toBeNull();
    const again = await owner.post("/api/numbers/sync");
    expect(again.numbers.find((n: { id: string }) => n.id === one.id).releasedAt).toBeNull();
    const missing = await owner.fetch(`/api/numbers/${crypto.randomUUID()}/restore-number`, {
      method: "POST",
      json: {},
    });
    expect(missing.status).toBe(404);
  });

  it("reuses the row when a number comes back under a new SID", async () => {
    twilioNumbers = [fake("PN1", "+14155550101")];
    const a = await owner.post("/api/numbers/sync");
    twilioNumbers = [fake("PN9", "+14155550101")];
    const b = await owner.post("/api/numbers/sync");
    expect(b.numbers).toHaveLength(1);
    expect(b.numbers[0]).toMatchObject({ id: a.numbers[0].id, twilioSid: "PN9" });
  });

  it("answers 503 without Twilio config and 502 with Twilio's message on a Twilio error", async () => {
    failWith = { status: 401, code: 20003, message: "Authenticate" };
    const res = await owner.fetch("/api/numbers/sync", { method: "POST" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "twilio_error" });
  });
});

describe("numbers CRUD", () => {
  async function two() {
    twilioNumbers = [fake("PN1", "+14155550101"), fake("PN2", "+14155550102")];
    const { numbers } = await owner.post("/api/numbers/sync");
    return numbers as { id: string; twilioSid: string; isDefault: boolean }[];
  }

  it("lists, renames and sets the default (one default only)", async () => {
    const [a, b] = await two();
    const list = await owner.json("PATCH", `/api/numbers/${b!.id}`, {
      friendlyName: "Work",
      isDefault: true,
    });
    expect(list.filter((n: { isDefault: boolean }) => n.isDefault).map((n: { id: string }) => n.id)).toEqual([
      b!.id,
    ]);
    expect(list.find((n: { id: string }) => n.id === b!.id).friendlyName).toBe("Work");
    expect((await owner.get("/api/preferences")).defaultNumberId).toBe(b!.id);
    expect((await owner.get("/api/numbers")).find((n: { id: string }) => n.id === a!.id).isDefault).toBe(
      false,
    );
  });

  it("rejects an empty patch and unknown ids", async () => {
    const [a] = await two();
    expect((await owner.fetch(`/api/numbers/${a!.id}`, { method: "PATCH", json: {} })).status).toBe(400);
    expect(
      (await owner.fetch("/api/numbers/nope", { method: "PATCH", json: { friendlyName: "x" } })).status,
    ).toBe(404);
  });

  it("soft-deletes: keeps the row and history, never calls Twilio, moves the default", async () => {
    const [a, b] = await two();
    const before = twilioCalls().length;
    const list = await owner.json("DELETE", `/api/numbers/${a!.id}`);
    expect(twilioCalls().length).toBe(before);
    const removed = list.find((n: { id: string }) => n.id === a!.id);
    expect(removed).toMatchObject({ isDefault: false });
    expect(removed.releasedAt).toBeTypeOf("number");
    expect(list.find((n: { id: string }) => n.id === b!.id).isDefault).toBe(true);
    const row = await env.DB.prepare("SELECT released_at FROM phone_numbers WHERE id = ?")
      .bind(a!.id)
      .first();
    expect(row?.released_at).not.toBeNull();
    // A removed number cannot become the default.
    expect(
      (await owner.fetch(`/api/numbers/${a!.id}`, { method: "PATCH", json: { isDefault: true } })).status,
    ).toBe(409);
  });
});

describe("connect and restore", () => {
  it("stores the previous routing, sets the exact URLs and clears the TwiML app", async () => {
    twilioNumbers = [fake("PN1", "+14155550101")];
    const [n] = (await owner.post("/api/numbers/sync")).numbers;
    const out = await owner.post(`/api/numbers/${n.id}/connect`);
    const u = ours();

    const post = twilioCalls().find((c) => c.method === "POST")!;
    expect(post.url.pathname).toBe(`${ACCOUNT}/IncomingPhoneNumbers/PN1.json`);
    expect(Object.fromEntries(post.form)).toEqual({
      VoiceUrl: u.voice,
      VoiceMethod: "POST",
      SmsUrl: u.sms,
      SmsMethod: "POST",
      StatusCallback: u.status,
      StatusCallbackMethod: "POST",
      VoiceApplicationSid: "",
    });
    expect(out.changed).toBe(true);
    expect(out.before).toMatchObject({
      voiceUrl: "https://old.example/voice",
      smsUrl: "https://old.example/sms",
      voiceApplicationSid: "APold0000000000000000000000000000",
    });
    expect(out.after).toMatchObject({
      voiceUrl: u.voice,
      voiceMethod: "POST",
      smsUrl: u.sms,
      smsMethod: "POST",
      statusCallback: u.status,
      voiceApplicationSid: null,
    });

    const audit = await env.DB.prepare(
      "SELECT action, target, metadata FROM audit_events WHERE action = 'number.connect'",
    ).all<{ action: string; target: string; metadata: string }>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0]!.target).toBe(n.id);
    expect(JSON.parse(audit.results[0]!.metadata).before).toMatchObject({
      voiceUrl: "https://old.example/voice",
      smsUrl: "https://old.example/sms",
    });
    expect((await owner.get("/api/numbers"))[0].restorable).toMatchObject({
      voiceUrl: "https://old.example/voice",
    });
  });

  it("does nothing the second time, and keeps the first stored values", async () => {
    twilioNumbers = [fake("PN1", "+14155550101")];
    const [n] = (await owner.post("/api/numbers/sync")).numbers;
    await owner.post(`/api/numbers/${n.id}/connect`);
    const posts = twilioCalls().filter((c) => c.method === "POST").length;
    const again = await owner.post(`/api/numbers/${n.id}/connect`);
    expect(again.changed).toBe(false);
    expect(twilioCalls().filter((c) => c.method === "POST").length).toBe(posts);
    const rows = await env.DB.prepare("SELECT id FROM audit_events WHERE action = 'number.connect'").all();
    expect(rows.results).toHaveLength(1);
  });

  it("treats a number with our URLs but GET methods as not connected", async () => {
    const u = ours();
    twilioNumbers = [
      fake("PN1", "+14155550101", {
        voice_url: u.voice,
        voice_method: "GET",
        sms_url: u.sms,
        sms_method: "POST",
        status_callback: u.status,
        voice_application_sid: null,
      }),
    ];
    const [n] = (await owner.post("/api/numbers/sync")).numbers;
    const out = await owner.post(`/api/numbers/${n.id}/connect`);
    expect(out.changed).toBe(true);
    expect(out.after).toMatchObject({ voiceMethod: "POST", smsMethod: "POST" });
    expect((await owner.post(`/api/numbers/${n.id}/connect`)).changed).toBe(false);
  });

  it("restores the stored routing and then has nothing left to restore", async () => {
    twilioNumbers = [fake("PN1", "+14155550101")];
    const [n] = (await owner.post("/api/numbers/sync")).numbers;
    await owner.post(`/api/numbers/${n.id}/connect`);
    const out = await owner.post(`/api/numbers/${n.id}/restore`);
    expect(out.after).toMatchObject({
      voiceUrl: "https://old.example/voice",
      voiceMethod: "GET",
      smsUrl: "https://old.example/sms",
      smsMethod: "GET",
      statusCallback: null,
      voiceApplicationSid: "APold0000000000000000000000000000",
    });
    expect(twilioNumbers[0]!.voice_url).toBe("https://old.example/voice");
    expect((await owner.get("/api/numbers"))[0].restorable).toBeNull();
    expect((await owner.fetch(`/api/numbers/${n.id}/restore`, { method: "POST", json: {} })).status).toBe(
      404,
    );
  });

  it("refuses to connect a removed number", async () => {
    twilioNumbers = [fake("PN1", "+14155550101")];
    const [n] = (await owner.post("/api/numbers/sync")).numbers;
    await owner.json("DELETE", `/api/numbers/${n.id}`);
    expect((await owner.fetch(`/api/numbers/${n.id}/connect`, { method: "POST", json: {} })).status).toBe(
      409,
    );
  });

  it("changes nothing at Twilio when it cannot read the current routing", async () => {
    twilioNumbers = [fake("PN1", "+14155550101")];
    const [n] = (await owner.post("/api/numbers/sync")).numbers;
    failWith = { status: 500, code: 20500, message: "boom" };
    expect((await owner.fetch(`/api/numbers/${n.id}/connect`, { method: "POST", json: {} })).status).toBe(
      502,
    );
    expect(twilioCalls().some((call) => call.url.pathname === `${ACCOUNT}.json`)).toBe(false);
    const rows = await env.DB.prepare("SELECT id FROM audit_events WHERE action = 'number.connect'").all();
    expect(rows.results).toHaveLength(0);
  });
});

describe("/api/preferences", () => {
  it("starts with the defaults", async () => {
    expect(await owner.get("/api/preferences")).toEqual({
      defaultNumberId: null,
      countryAllowlist: [],
      locale: "en",
      theme: "system",
      smsPerHour: 30,
      callsPerHour: 20,
      digestEnabled: false,
      digestTime: "08:00",
      timezone: "UTC",
    });
  });

  it("saves, normalizes and de-duplicates the allowlist, and merges partial updates", async () => {
    const out = await owner.json("PUT", "/api/preferences", {
      countryAllowlist: ["us", "GB", "US"],
      smsPerHour: 5,
      theme: "dark",
    });
    expect(out).toMatchObject({
      countryAllowlist: ["GB", "US"],
      smsPerHour: 5,
      callsPerHour: 20,
      theme: "dark",
    });
    const next = await owner.json("PUT", "/api/preferences", { callsPerHour: 3 });
    expect(next).toMatchObject({ countryAllowlist: ["GB", "US"], smsPerHour: 5, callsPerHour: 3 });
  });

  it("rejects bad input with 400", async () => {
    const bad = [
      { countryAllowlist: ["ZZ"] },
      { countryAllowlist: ["USA"] },
      { countryAllowlist: "US" },
      { smsPerHour: -1 },
      { smsPerHour: 1.5 },
      { smsPerHour: 100000 },
      { callsPerHour: 5000 },
      { theme: "neon" },
      { locale: "xx" },
      { defaultNumberId: "not-a-real-number" },
      { unknownField: 1 },
    ];
    for (const body of bad)
      expect(
        (await owner.fetch("/api/preferences", { method: "PUT", json: body })).status,
        JSON.stringify(body),
      ).toBe(400);
  });

  it("sets the default number and keeps phone_numbers in step; rejects released numbers", async () => {
    twilioNumbers = [fake("PN1", "+14155550101"), fake("PN2", "+14155550102")];
    const { numbers } = await owner.post("/api/numbers/sync");
    const out = await owner.json("PUT", "/api/preferences", { defaultNumberId: numbers[1].id });
    expect(out.defaultNumberId).toBe(numbers[1].id);
    const list = await owner.get("/api/numbers");
    expect(list.find((n: { isDefault: boolean }) => n.isDefault).id).toBe(numbers[1].id);
    await owner.json("DELETE", `/api/numbers/${numbers[0].id}`);
    expect(
      (await owner.fetch("/api/preferences", { method: "PUT", json: { defaultNumberId: numbers[0].id } }))
        .status,
    ).toBe(400);
  });

  it("refuses a null default while active numbers exist, and allows it when none are left", async () => {
    twilioNumbers = [fake("PN1", "+14155550101")];
    const { numbers } = await owner.post("/api/numbers/sync");
    const refused = await owner.fetch("/api/preferences", { method: "PUT", json: { defaultNumberId: null } });
    expect(refused.status).toBe(400);
    expect((await owner.get("/api/preferences")).defaultNumberId).toBe(numbers[0].id);
    expect((await owner.get("/api/numbers"))[0].isDefault).toBe(true);
    await owner.json("DELETE", `/api/numbers/${numbers[0].id}`);
    const out = await owner.json("PUT", "/api/preferences", { defaultNumberId: null });
    expect(out.defaultNumberId).toBeNull();
  });
});

describe("/api/billing", () => {
  it("returns balance and this month's usage with labels", async () => {
    const out = await owner.get("/api/billing");
    expect(out.balance).toEqual({ amount: "12.3400", currency: "USD" });
    expect(out.period).toEqual({ start: "2026-11-01", end: "2026-11-30", label: "this month" });
    expect(out.usage.calls).toEqual({
      count: "7",
      usage: "5",
      usageUnit: "minutes",
      price: "0.42",
      priceUnit: "usd",
    });
    expect(out.usage.sms.usageUnit).toBe("messages");
    expect(out.usage.total.price).toBe("0.42");
    const cats = twilioCalls()
      .filter((c) => c.url.pathname.endsWith("ThisMonth.json"))
      .map((c) => c.url.searchParams.get("Category"))
      .sort();
    expect(cats).toEqual(["calls", "sms", "totalprice"]);
  });

  it("caches for five minutes", async () => {
    await owner.get("/api/billing");
    const n = twilioCalls().length;
    await owner.get("/api/billing");
    expect(twilioCalls().length).toBe(n);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60 * 1000 + 1000);
    await owner.get("/api/billing");
    expect(twilioCalls().length).toBeGreaterThan(n);
  });

  it("answers 503 when Twilio is not configured", async () => {
    const saved = vars.TWILIO_API_KEY_SECRET;
    vars.TWILIO_API_KEY_SECRET = "";
    try {
      const res = await owner.fetch("/api/billing");
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "not_configured" });
    } finally {
      vars.TWILIO_API_KEY_SECRET = saved;
    }
  });
});

describe("/api/status", () => {
  it("reports which settings exist as booleans and never a value", async () => {
    const res = await owner.fetch("/api/status/config");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      twilioAccountSid: true,
      twilioApiKey: true,
      twilioAuthToken: true,
      twilioTwimlApp: true,
      publicUrl: true,
      vapid: false,
      oidc: false,
      setupToken: true,
    });
    for (const secret of [
      vars.TWILIO_API_KEY_SECRET,
      vars.TWILIO_AUTH_TOKEN,
      vars.TWILIO_ACCOUNT_SID,
      vars.TWILIO_API_KEY_SID,
      vars.TWILIO_TWIML_APP_SID,
      env.SETUP_TOKEN,
      vars.BETTER_AUTH_SECRET,
    ])
      expect(text).not.toContain(secret as string);
  });

  it("flags missing settings", async () => {
    const saved = vars.TWILIO_AUTH_TOKEN;
    vars.TWILIO_AUTH_TOKEN = undefined;
    try {
      expect((await owner.get("/api/status/config")).twilioAuthToken).toBe(false);
    } finally {
      vars.TWILIO_AUTH_TOKEN = saved;
    }
  });

  it("tests the connection with one GET of the balance and returns the currency only", async () => {
    const res = await owner.fetch("/api/status/twilio-test", { method: "POST", json: {} });
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, currency: "USD" });
    expect(text).not.toContain("12.34");
    expect(twilioCalls()).toHaveLength(1);
    expect(twilioCalls()[0]!.method).toBe("GET");
    expect(twilioCalls()[0]!.url.pathname).toBe(`${ACCOUNT}/Balance.json`);
  });

  it("never reads the account resource, which standard API keys get a 401 on", async () => {
    const out = await owner.post("/api/status/twilio-test");
    expect(out.ok).toBe(true);
    expect(twilioCalls().some((call) => call.url.pathname === `${ACCOUNT}.json`)).toBe(false);
  });

  it("reports a Twilio failure as ok false", async () => {
    failWith = { status: 401, code: 20003, message: "Authenticate" };
    const out = await owner.post("/api/status/twilio-test");
    expect(out).toEqual({ ok: false, error: "Authenticate", code: 20003 });
  });
});
