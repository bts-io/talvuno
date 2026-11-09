import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cronJobs } from "../../src/worker/cron";
import { voiceIdentity } from "../../src/worker/lib/voice/identity";
import { reconcileStuckCalls, STUCK_CALL_AGE_MS } from "../../src/worker/lib/voice/reconcile";
import { el, response, text } from "../../src/worker/lib/voice/twiml";
import { CALL_TIME_LIMIT_SECONDS, SPOKEN } from "../../src/worker/routes/twilio-voice";
import { b64u, newReceiver, newVapid } from "../unit/webpush-decrypt";
import { createOwner, resetDb, Session } from "./helpers";
import { signedTwilioPost } from "./twilio-helpers";

beforeEach(resetDb);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  env.VAPID_PUBLIC_KEY = undefined;
  env.VAPID_PRIVATE_KEY = undefined;
  env.VAPID_SUBJECT = undefined;
});

declare global {
  namespace Cloudflare {
    interface Env {
      VAPID_PUBLIC_KEY?: string;
      VAPID_PRIVATE_KEY?: string;
      VAPID_SUBJECT?: string;
    }
  }
}

const PUSH_ENDPOINT = "https://push.example.test/device";

/**
 * Turns web push on for the owner with one device and counts the notices the Worker sends to it. No tab is
 * open in these tests, so every event that carries `push` goes out as one web push.
 */
async function countPushes(ownerId: string) {
  const vapid = await newVapid();
  env.VAPID_PUBLIC_KEY = vapid.publicKey;
  env.VAPID_PRIVATE_KEY = vapid.privateKey;
  env.VAPID_SUBJECT = vapid.subject;
  const r = await newReceiver();
  await env.DB.prepare(
    "INSERT INTO push_subscriptions (id, owner_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      ownerId,
      PUSH_ENDPOINT,
      b64u.encode(r.publicKey),
      b64u.encode(r.authSecret),
      Date.now(),
    )
    .run();
  const sent: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    sent.push(url);
    return new Response(null, { status: 201 });
  });
  // Pushes are handed to waitUntil, so they can land just after the response: wait for them to settle.
  return async () => {
    await new Promise((r) => setTimeout(r, 200));
    return sent.filter((u) => u === PUSH_ENDPOINT).length;
  };
}

const OURS = "+14155550100";
const OURS_2 = "+14155550111";
const US = "+14155552671";
const UK = "+447911123456";
const PARENT = "CA00000000000000000000000000000001";
const CHILD = "CA00000000000000000000000000000002";

let seq = 0;
async function addNumber(
  ownerId: string,
  e164: string,
  opts: { isDefault?: boolean; released?: boolean } = {},
) {
  const id = crypto.randomUUID();
  seq++;
  await env.DB.prepare(
    "INSERT INTO phone_numbers (id, owner_id, e164, twilio_sid, friendly_name, capabilities, is_default, released_at, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      ownerId,
      e164,
      `PN${String(seq).padStart(32, "0")}`,
      JSON.stringify({ voice: true, sms: true, mms: false }),
      opts.isDefault ? 1 : 0,
      opts.released ? Date.now() : null,
      Date.now() + seq,
      Date.now(),
    )
    .run();
  return id;
}

async function allow(ownerId: string, countries: string[], callsPerHour = 20) {
  await env.DB.prepare(
    "INSERT INTO user_preferences (user_id, country_allowlist, calls_per_hour, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET country_allowlist = excluded.country_allowlist, calls_per_hour = excluded.calls_per_hour",
  )
    .bind(ownerId, JSON.stringify(countries), callsPerHour, Date.now())
    .run();
}

type CallRowRaw = {
  twilio_call_sid: string;
  direction: string;
  status: string;
  party: string;
  number_id: string | null;
  answered_at: number | null;
  ended_at: number | null;
  duration: number | null;
  contact_id: string | null;
};
const calls = async () =>
  (await env.DB.prepare("SELECT * FROM calls ORDER BY created_at").all<CallRowRaw>()).results;

async function setup() {
  const owner = await createOwner();
  const numberId = await addNumber(owner.userId, OURS, { isDefault: true });
  await allow(owner.userId, ["US"]);
  return { owner, numberId, from: `client:${voiceIdentity(owner.userId)}` };
}

const outbound = (from: string, to: string, extra: Record<string, string> = {}, callSid = PARENT) =>
  signedTwilioPost("/api/twilio/voice/outbound", {
    CallSid: callSid,
    AccountSid: "AC00000000000000000000000000000000",
    From: from,
    To: to,
    Direction: "inbound",
    ...extra,
  });

const status = (callSid: string, callStatus: string, extra: Record<string, string> = {}) =>
  signedTwilioPost("/api/twilio/voice/status", { CallSid: callSid, CallStatus: callStatus, ...extra });

describe("POST /api/twilio/voice/outbound", () => {
  it("dials an allowed number from the default number and records the call by the parent SID", async () => {
    const { from, numberId } = await setup();
    const res = await outbound(from, US);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    const xml = await res.text();
    expect(xml).toContain(
      `<Dial callerId="${OURS}" answerOnBridge="true" timeLimit="7200" action="https://talvuno.test/api/twilio/voice/outbound-complete" method="POST">`,
    );
    expect(xml).toContain(
      `<Number statusCallback="https://talvuno.test/api/twilio/voice/status" statusCallbackEvent="initiated ringing answered completed" statusCallbackMethod="POST">${US}</Number>`,
    );
    expect(await calls()).toMatchObject([
      { twilio_call_sid: PARENT, direction: "outbound", party: US, number_id: numberId, status: "queued" },
    ]);
  });

  it("uses a chosen caller ID that is ours", async () => {
    const { owner, from } = await setup();
    await addNumber(owner.userId, OURS_2);
    const xml = await (await outbound(from, US, { CallerId: OURS_2 })).text();
    expect(xml).toContain(`callerId="${OURS_2}"`);
  });

  it("refuses a foreign or released caller ID without dialing", async () => {
    const { owner, from } = await setup();
    await addNumber(owner.userId, OURS_2, { released: true });
    for (const callerId of ["+14155559999", OURS_2]) {
      const xml = await (await outbound(from, US, { CallerId: callerId })).text();
      expect(xml).not.toContain("<Dial");
      expect(xml).toContain(`<Say>${SPOKEN.callerId}</Say><Hangup/>`);
    }
    expect(await calls()).toEqual([]);
  });

  it("refuses a wrong identity", async () => {
    await setup();
    for (const from of ["client:owner_somebodyelse", "client:intruder", "+14155552671", ""]) {
      const xml = await (await outbound(from, US)).text();
      expect(xml).not.toContain("<Dial");
      expect(xml).toContain(`<Say>${SPOKEN.notAllowed}</Say><Hangup/>`);
    }
    expect(await calls()).toEqual([]);
  });

  it("refuses countries outside the allowlist, invalid numbers and the hourly limit", async () => {
    const { owner, from } = await setup();
    expect(await (await outbound(from, UK)).text()).toContain(`<Say>${SPOKEN.country}</Say><Hangup/>`);
    expect(await (await outbound(from, "12345")).text()).toContain(SPOKEN.invalidNumber);
    await allow(owner.userId, ["US"], 1);
    expect(await (await outbound(from, US, {}, "CA0000000000000000000000000000000a")).text()).toContain(
      "<Dial",
    );
    const limited = await (await outbound(from, US, {}, "CA0000000000000000000000000000000b")).text();
    expect(limited).toContain(SPOKEN.limit);
    expect(limited).not.toContain("<Dial");
    expect((await calls()).length).toBe(1);
  });

  it("answers a retried request with the same dial and spends one call", async () => {
    const { owner, from } = await setup();
    await allow(owner.userId, ["US"], 1);
    expect(await (await outbound(from, US)).text()).toContain("<Dial");
    expect(await (await outbound(from, US)).text()).toContain("<Dial");
    expect((await calls()).length).toBe(1);
  });

  it("refuses a destination that carries markup, without dialing", async () => {
    const { from } = await setup();
    const xml = await (await outbound(from, `${US}<Play>x</Play>`)).text();
    expect(xml).not.toContain("<Play>");
    expect(xml).not.toContain("<Dial");
  });

  it("escapes every attribute and text value it writes into TwiML", () => {
    const evil = `"/><Play>x</Play><Say a='1'>&`;
    const xml = response(el("Dial", { callerId: evil }, el("Number", {}, text(evil))));
    expect(xml).not.toContain("<Play>");
    expect(xml).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="&quot;/&gt;&lt;Play&gt;x&lt;/Play&gt;&lt;Say a=&apos;1&apos;&gt;&amp;"><Number>&quot;/&gt;&lt;Play&gt;x&lt;/Play&gt;&lt;Say a=&apos;1&apos;&gt;&amp;</Number></Dial></Response>`,
    );
  });

  it("caps every call at two hours", () => {
    expect(CALL_TIME_LIMIT_SECONDS).toBe(7200);
  });

  it("is refused without a valid Twilio signature", async () => {
    const { from } = await setup();
    const res = await signedTwilioPost(
      "/api/twilio/voice/outbound",
      { CallSid: PARENT, From: from, To: US },
      {
        signature: "bogus",
      },
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /api/twilio/voice/inbound", () => {
  it("rejects a call to a number that is not ours or was released", async () => {
    const { owner } = await setup();
    await addNumber(owner.userId, OURS_2, { released: true });
    for (const to of ["+14155559999", OURS_2]) {
      const xml = await (
        await signedTwilioPost("/api/twilio/voice/inbound", { CallSid: PARENT, From: US, To: to })
      ).text();
      expect(xml).toContain("<Reject/>");
      expect(xml).not.toContain("<Dial");
    }
    expect(await calls()).toEqual([]);
  });

  it("rings the owner's browser and records the call, withheld callers included", async () => {
    const { owner, numberId } = await setup();
    const xml = await (
      await signedTwilioPost("/api/twilio/voice/inbound", {
        CallSid: PARENT,
        From: "anonymous",
        To: OURS,
        CallStatus: "ringing",
      })
    ).text();
    expect(xml).toContain(
      `<Dial timeout="25" answerOnBridge="true" timeLimit="7200" action="https://talvuno.test/api/twilio/voice/inbound-complete" method="POST">`,
    );
    expect(xml).toContain(
      `<Client statusCallback="https://talvuno.test/api/twilio/voice/status" statusCallbackEvent="initiated ringing answered completed" statusCallbackMethod="POST"><Identity>${voiceIdentity(owner.userId)}</Identity>`,
    );
    expect(await calls()).toMatchObject([
      {
        twilio_call_sid: PARENT,
        direction: "inbound",
        party: "anonymous",
        number_id: numberId,
        status: "ringing",
      },
    ]);
  });

  it("links a known contact and passes its name to the browser", async () => {
    const { owner } = await setup();
    const contactId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO contacts (id, owner_id, display_name, created_at, updated_at) VALUES (?, ?, 'Ada \"/><Play>x</Play>', ?, ?)",
      ).bind(contactId, owner.userId, Date.now(), Date.now()),
      env.DB.prepare("INSERT INTO contact_numbers (id, contact_id, e164) VALUES (?, ?, ?)").bind(
        crypto.randomUUID(),
        contactId,
        US,
      ),
    ]);
    const xml = await (
      await signedTwilioPost("/api/twilio/voice/inbound", { CallSid: PARENT, From: US, To: OURS })
    ).text();
    expect(xml).toContain(
      `<Parameter name="contactName" value="Ada &quot;/&gt;&lt;Play&gt;x&lt;/Play&gt;"/>`,
    );
    expect(xml).not.toContain("<Play>");
    expect((await calls())[0]?.contact_id).toBe(contactId);
  });
});

describe("POST /api/twilio/voice/inbound-complete", () => {
  async function ringing() {
    const s = await setup();
    await signedTwilioPost("/api/twilio/voice/inbound", { CallSid: PARENT, From: US, To: OURS });
    return s;
  }

  it("says the unavailable message and marks the call missed when nobody answered", async () => {
    await ringing();
    const res = await signedTwilioPost("/api/twilio/voice/inbound-complete", {
      CallSid: PARENT,
      DialCallSid: CHILD,
      DialCallStatus: "no-answer",
    });
    const xml = await res.text();
    expect(xml).toContain(`<Say>${SPOKEN.unavailable}</Say><Hangup/>`);
    expect(xml).not.toContain("<Record");
    expect(await calls()).toMatchObject([{ status: "no-answer", answered_at: null, duration: 0 }]);
  });

  it("hangs up quietly after an answered call", async () => {
    await ringing();
    await status(CHILD, "in-progress", { ParentCallSid: PARENT });
    const xml = await (
      await signedTwilioPost("/api/twilio/voice/inbound-complete", {
        CallSid: PARENT,
        DialCallSid: CHILD,
        DialCallStatus: "completed",
        DialCallDuration: "42",
      })
    ).text();
    expect(xml).toContain("<Hangup/>");
    expect(xml).not.toContain("<Say>");
    expect(await calls()).toMatchObject([{ status: "completed", duration: 42 }]);
  });
});

describe("inbound call ringing two devices", () => {
  const CHILD_B = "CA00000000000000000000000000000003";
  const child = (sid: string, st: string, extra: Record<string, string> = {}) =>
    status(sid, st, { ParentCallSid: PARENT, ...extra });
  const dialDone = async (dialStatus: string, extra: Record<string, string> = {}) =>
    (
      await signedTwilioPost("/api/twilio/voice/inbound-complete", {
        CallSid: PARENT,
        DialCallStatus: dialStatus,
        ...extra,
      })
    ).text();

  async function ringingTwo() {
    const s = await setup();
    await signedTwilioPost("/api/twilio/voice/inbound", { CallSid: PARENT, From: US, To: OURS });
    for (const sid of [CHILD, CHILD_B]) await child(sid, "ringing");
    return s;
  }

  it("keeps the call open when the other device is canceled before the answer", async () => {
    await ringingTwo();
    await child(CHILD_B, "canceled");
    expect(await calls()).toMatchObject([{ status: "ringing", ended_at: null }]);
    await child(CHILD, "in-progress");
    await child(CHILD, "completed", { CallDuration: "30" });
    const xml = await dialDone("completed", { DialCallSid: CHILD, DialCallDuration: "30" });
    expect(xml).not.toContain("<Say>");
    const [row] = await calls();
    expect(row).toMatchObject({ status: "completed", duration: 30 });
    expect(row?.answered_at).not.toBeNull();
  });

  it("keeps the answered call when the other device is canceled after the answer", async () => {
    await ringingTwo();
    await child(CHILD, "in-progress");
    await child(CHILD_B, "canceled");
    expect(await calls()).toMatchObject([{ status: "in-progress", ended_at: null }]);
    await child(CHILD, "completed", { CallDuration: "45" });
    expect(await calls()).toMatchObject([{ status: "completed", duration: 45 }]);
  });

  it("hangs up quietly when the owner ends an answered call first", async () => {
    const { owner } = await ringingTwo();
    const pushes = await countPushes(owner.userId);
    await child(CHILD, "in-progress");
    await child(CHILD_B, "canceled");
    // The owner hangs up: the browser leg completes, then Twilio asks the Dial action what to do next.
    await child(CHILD, "completed", { CallDuration: "20" });
    const xml = await dialDone("completed", { DialCallSid: CHILD, DialCallDuration: "20" });
    expect(xml).toContain("<Hangup/>");
    expect(xml).not.toContain(SPOKEN.unavailable);
    // The parent leg ends last and changes nothing.
    await status(PARENT, "completed", { CallDuration: "26" });
    expect(await calls()).toMatchObject([{ status: "completed", duration: 20 }]);
    expect(await pushes()).toBe(0);
  });

  it("decides the caller's message from DialCallStatus even before any child answer arrived", async () => {
    await ringingTwo();
    const xml = await dialDone("answered", { DialCallSid: CHILD, DialCallDuration: "15" });
    expect(xml).not.toContain(SPOKEN.unavailable);
    expect(await calls()).toMatchObject([{ status: "completed", duration: 15 }]);
  });

  it("marks a real missed call and pushes it exactly once", async () => {
    const { owner } = await ringingTwo();
    const pushes = await countPushes(owner.userId);
    for (const sid of [CHILD, CHILD_B]) await child(sid, "no-answer");
    expect(await calls()).toMatchObject([{ status: "ringing" }]);
    const xml = await dialDone("no-answer");
    expect(xml).toContain(`<Say>${SPOKEN.unavailable}</Say><Hangup/>`);
    await dialDone("no-answer");
    await status(PARENT, "completed", { CallDuration: "30" });
    expect(await calls()).toMatchObject([{ status: "no-answer", answered_at: null, duration: 0 }]);
    expect(await pushes()).toBe(1);
    const list = await owner.get<{ items: { missed: boolean }[] }>("/api/calls?filter=missed");
    expect(list.items.map((i) => i.missed)).toEqual([true]);
  });
});

describe("POST /api/twilio/voice/status", () => {
  async function dialed() {
    const s = await setup();
    await outbound(s.from, US);
    return s;
  }

  it("applies the dialed (child) leg to the parent's row: one row per call with the PSTN result", async () => {
    await dialed();
    for (const st of ["initiated", "ringing", "in-progress"])
      expect((await status(CHILD, st, { ParentCallSid: PARENT })).status).toBe(200);
    let [row] = await calls();
    expect(row).toMatchObject({ twilio_call_sid: PARENT, status: "in-progress" });
    expect(row?.answered_at).not.toBeNull();
    await status(CHILD, "completed", { ParentCallSid: PARENT, CallDuration: "61" });
    const rows = await calls();
    expect(rows.length).toBe(1);
    [row] = rows;
    expect(row).toMatchObject({ status: "completed", duration: 61 });
    expect(row?.ended_at).not.toBeNull();
  });

  it("keeps a busy PSTN result even when the browser leg reports completed", async () => {
    await dialed();
    await status(CHILD, "busy", { ParentCallSid: PARENT });
    await status(PARENT, "completed", { CallDuration: "5" });
    expect(await calls()).toMatchObject([{ status: "busy", answered_at: null, duration: 0 }]);
  });

  it("never moves backwards when callbacks arrive out of order", async () => {
    await dialed();
    await status(CHILD, "completed", { ParentCallSid: PARENT, CallDuration: "30" });
    await status(CHILD, "ringing", { ParentCallSid: PARENT });
    await status(CHILD, "in-progress", { ParentCallSid: PARENT });
    const [row] = await calls();
    expect(row).toMatchObject({ status: "completed", duration: 30 });
    expect(row?.answered_at).not.toBeNull();
  });

  it("processes a replayed callback once", async () => {
    const { owner } = await setup();
    await signedTwilioPost("/api/twilio/voice/inbound", { CallSid: PARENT, From: US, To: OURS });
    const pushes = await countPushes(owner.userId);
    // The caller hangs up while it rings: this closes the row as missed and pushes. Twilio delivers it twice.
    await status(PARENT, "completed", { CallDuration: "12" });
    await status(PARENT, "completed", { CallDuration: "12" });
    expect(await pushes()).toBe(1);
    const events = await env.DB.prepare(
      "SELECT idempotency_key, attempts, processed_at FROM webhook_events WHERE type = 'voice-status'",
    ).all<{ idempotency_key: string; attempts: number; processed_at: number | null }>();
    expect(events.results).toEqual([
      { idempotency_key: `voice-status:${PARENT}:completed`, attempts: 1, processed_at: expect.any(Number) },
    ]);
  });

  it("closes an inbound call the caller hung up on as missed, from the parent leg", async () => {
    await setup();
    await signedTwilioPost("/api/twilio/voice/inbound", { CallSid: PARENT, From: US, To: OURS });
    await status(PARENT, "completed", { CallDuration: "12" });
    expect(await calls()).toMatchObject([{ status: "no-answer", answered_at: null, duration: 0 }]);
  });

  it("answers 200 for a callback about a call it does not know", async () => {
    await setup();
    const res = await status("CA0000000000000000000000000000ffff", "completed");
    expect(res.status).toBe(200);
    expect(await calls()).toEqual([]);
  });
});

describe("POST /api/voice/token", () => {
  it("needs the owner's session", async () => {
    await setup();
    const res = await new Session().fetch("/api/voice/token", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("refuses a cross-site request", async () => {
    const { owner } = await setup();
    const res = await owner.fetch("/api/voice/token", { method: "POST", origin: "https://evil.test" });
    expect(res.status).toBe(403);
  });

  it("issues a one hour token for the owner's identity, ignoring any identity in the request", async () => {
    const { owner } = await setup();
    const body = await owner.post<{ token: string; identity: string; ttl: number }>("/api/voice/token", {
      identity: "someone_else",
    });
    expect(body.identity).toBe(voiceIdentity(owner.userId));
    expect(body.ttl).toBe(3600);
    const payload = JSON.parse(atob(body.token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(payload.grants.identity).toBe(voiceIdentity(owner.userId));
    expect(payload.exp - payload.iat).toBe(3600);
  });

  it("lists usable caller IDs with the default first", async () => {
    const { owner } = await setup();
    await addNumber(owner.userId, OURS_2);
    await addNumber(owner.userId, "+14155550122", { released: true });
    const body = await owner.get<{ numbers: { e164: string; isDefault: boolean }[] }>(
      "/api/voice/caller-ids",
    );
    expect(body.numbers.map((n) => [n.e164, n.isDefault])).toEqual([
      [OURS, true],
      [OURS_2, false],
    ]);
  });
});

describe("cron: stuck call reconcile", () => {
  async function stuckCall(sid = PARENT) {
    const { owner } = await setup();
    await env.DB.prepare(
      "INSERT INTO calls (id, owner_id, twilio_call_sid, direction, party, status, started_at, created_at, updated_at) VALUES (?, ?, ?, 'outbound', ?, 'ringing', ?, ?, ?)",
    )
      .bind(
        crypto.randomUUID(),
        owner.userId,
        sid,
        US,
        Date.now() - STUCK_CALL_AGE_MS - 60_000,
        Date.now(),
        Date.now(),
      )
      .run();
    return owner;
  }

  function mockTwilio(routes: Record<string, Response | (() => Response)>) {
    const fn = vi.fn(async (input: RequestInfo | URL) => {
      const u = new URL(String(input instanceof Request ? input.url : input));
      const key = `${u.pathname.replace(/^.*\/Accounts\/[^/]+/, "")}${u.searchParams.get("ParentCallSid") ? "?children" : ""}`;
      const r = routes[key];
      if (!r) return Response.json({ code: 20404, message: "not found" }, { status: 404 });
      return typeof r === "function" ? r() : r.clone();
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("is registered as a cron job", () => {
    expect(cronJobs).toContain(reconcileStuckCalls);
  });

  it("applies the dialed leg's final state from Twilio", async () => {
    await stuckCall();
    const fetch = mockTwilio({
      "/Calls.json?children": Response.json({
        calls: [
          { sid: CHILD, status: "completed", duration: "75", end_time: "Mon, 09 Nov 2026 10:00:00 +0000" },
        ],
      }),
    });
    await reconcileStuckCalls(env);
    expect(fetch).toHaveBeenCalled();
    const [row] = await calls();
    expect(row).toMatchObject({
      status: "completed",
      duration: 75,
      ended_at: Date.parse("2026-11-09T10:00:00Z"),
    });
  });

  it("prefers the completed child over another device's unanswered end", async () => {
    await stuckCall();
    await env.DB.prepare("UPDATE calls SET direction = 'inbound'").run();
    mockTwilio({
      "/Calls.json?children": Response.json({
        calls: [
          { sid: "CA00000000000000000000000000000003", status: "canceled", duration: "0" },
          { sid: CHILD, status: "completed", duration: "50", end_time: "Mon, 09 Nov 2026 10:00:00 +0000" },
        ],
      }),
    });
    await reconcileStuckCalls(env);
    const [row] = await calls();
    expect(row).toMatchObject({ status: "completed", duration: 50 });
    expect(row?.answered_at).not.toBeNull();
  });

  it("closes an inbound call whose devices all ended unanswered as missed", async () => {
    await stuckCall();
    await env.DB.prepare("UPDATE calls SET direction = 'inbound'").run();
    mockTwilio({
      "/Calls.json?children": Response.json({
        calls: [
          { sid: CHILD, status: "no-answer", duration: "0" },
          { sid: "CA00000000000000000000000000000003", status: "canceled", duration: "0" },
        ],
      }),
    });
    await reconcileStuckCalls(env);
    expect(await calls()).toMatchObject([{ status: "no-answer", answered_at: null, duration: 0 }]);
  });

  it("falls back to the parent leg and treats an unanswered end as canceled", async () => {
    await stuckCall();
    mockTwilio({
      "/Calls.json?children": Response.json({ calls: [] }),
      [`/Calls/${PARENT}.json`]: Response.json({ sid: PARENT, status: "completed", duration: "3" }),
    });
    await reconcileStuckCalls(env);
    expect(await calls()).toMatchObject([{ status: "canceled", duration: 0 }]);
  });

  it("leaves calls Twilio still reports as live, and ignores fresh calls", async () => {
    await stuckCall();
    const fetch = mockTwilio({
      "/Calls.json?children": Response.json({ calls: [{ sid: CHILD, status: "in-progress" }] }),
      [`/Calls/${PARENT}.json`]: Response.json({ sid: PARENT, status: "in-progress" }),
    });
    await reconcileStuckCalls(env);
    expect(await calls()).toMatchObject([{ status: "ringing" }]);
    fetch.mockClear();
    await env.DB.prepare("UPDATE calls SET started_at = ?").bind(Date.now()).run();
    await reconcileStuckCalls(env);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("closes a call Twilio does not know as failed", async () => {
    await stuckCall();
    mockTwilio({});
    await reconcileStuckCalls(env);
    expect(await calls()).toMatchObject([{ status: "failed" }]);
  });

  it("does not move a call that a late webhook already finished", async () => {
    await stuckCall();
    await env.DB.prepare("UPDATE calls SET status = 'busy', ended_at = ?").bind(Date.now()).run();
    const fetch = mockTwilio({});
    await reconcileStuckCalls(env);
    expect(fetch).not.toHaveBeenCalled();
    expect(await calls()).toMatchObject([{ status: "busy" }]);
  });
});

describe("outbound call failure reasons", () => {
  const dialDone = (extra: Record<string, string>) =>
    signedTwilioPost("/api/twilio/voice/outbound-complete", { CallSid: PARENT, ...extra });

  /** Opens the owner's live socket and collects its frames as parsed objects. */
  async function openLive(owner: Session) {
    const res = await owner.fetch("/api/live", { headers: { upgrade: "websocket" } });
    const ws = res.webSocket!;
    const frames: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
    ws.accept();
    return { ws, frames };
  }

  it("stores Twilio's error code from the Dial action and sends it in the live event", async () => {
    const { owner, from } = await setup();
    await outbound(from, US);
    const live = await openLive(owner);

    const res = await dialDone({
      DialCallStatus: "failed",
      ErrorCode: "13227",
      ErrorMessage: "No International Permission. Enable the Low Risk permission for PK",
    });
    expect(res.status).toBe(200);

    expect(await calls()).toMatchObject([
      {
        status: "failed",
        error_code: 13227,
        error_message: "No International Permission. Enable the Low Risk permission for PK",
      },
    ]);
    await vi.waitFor(() =>
      expect(live.frames).toContainEqual(
        expect.objectContaining({ type: "call", status: "failed", errorCode: 13227, callSid: PARENT }),
      ),
    );
    live.ws.close();
  });

  it("keeps the code from the child leg callback when the Dial action has none", async () => {
    const { from } = await setup();
    await outbound(from, US);
    await status(CHILD, "failed", {
      ParentCallSid: PARENT,
      ErrorCode: "13224",
      ErrorMessage: "Invalid number",
    });
    await dialDone({ DialCallStatus: "failed" });
    expect(await calls()).toMatchObject([
      { status: "failed", error_code: 13224, error_message: "Invalid number" },
    ]);
  });

  it("stores no code for a call that completed", async () => {
    const { from } = await setup();
    await outbound(from, US);
    await dialDone({ DialCallStatus: "completed", DialCallDuration: "5", ErrorCode: "13227" });
    expect(await calls()).toMatchObject([{ status: "completed", error_code: null }]);
  });
});
