import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cronJobs } from "../../src/worker/cron";
import { createDb } from "../../src/worker/db";
import { voiceIdentity } from "../../src/worker/lib/voice/identity";
import { reconcileStuckCalls, STUCK_CALL_AGE_MS } from "../../src/worker/lib/voice/reconcile";
import { DEFAULT_GREETING, quietPushNow } from "../../src/worker/lib/voice/routing";
import { el, response, sayAndHangUp, text } from "../../src/worker/lib/voice/twiml";
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

/**
 * Like countPushes, but keeps every push request (headers included), so a test can check urgency and TTL.
 * Other fetches (Twilio REST) are answered 204 and not kept.
 */
async function capturePushes(ownerId: string) {
  await countPushes(ownerId);
  const sent: { headers: Headers }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url !== PUSH_ENDPOINT) return new Response(null, { status: 204 });
    sent.push({ headers: new Headers(init?.headers) });
    return new Response(null, { status: 201 });
  });
  return async () => {
    await new Promise((r) => setTimeout(r, 200));
    return sent;
  };
}

const QUEUE_SID = "QU00000000000000000000000000000001";
const ANSWER = "CA00000000000000000000000000000009";
const ANSWER_B = "CA0000000000000000000000000000000a";
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
  id: string;
  outcome: string | null;
  queue_name: string | null;
  answer_call_sid: string | null;
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

  it("queues the caller in a queue of its own with ringback, withheld callers included", async () => {
    const { numberId } = await setup();
    const xml = await (
      await signedTwilioPost("/api/twilio/voice/inbound", {
        CallSid: PARENT,
        From: "anonymous",
        To: OURS,
        CallStatus: "ringing",
      })
    ).text();
    const [row] = await calls();
    expect(row).toMatchObject({
      twilio_call_sid: PARENT,
      direction: "inbound",
      party: "anonymous",
      number_id: numberId,
      status: "ringing",
      outcome: null,
    });
    expect(row?.queue_name).toMatch(/^tq_[0-9a-f]{32}$/);
    expect(xml).toBe(
      response(
        `<Enqueue action="https://talvuno.test/api/twilio/voice/queue-done" method="POST" waitUrl="https://talvuno.test/api/twilio/voice/queue-wait" waitUrlMethod="POST">${row?.queue_name}</Enqueue>`,
      ),
    );
    expect(xml).not.toContain("<Client");
  });

  it("answers a retried request with the same queue", async () => {
    await setup();
    const first = await inbound();
    const second = await inbound();
    expect(second).toBe(first);
    expect(await calls()).toHaveLength(1);
  });

  it("links a known contact", async () => {
    const { owner } = await setup();
    const contactId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO contacts (id, owner_id, display_name, created_at, updated_at) VALUES (?, ?, 'Ada', ?, ?)",
      ).bind(contactId, owner.userId, Date.now(), Date.now()),
      env.DB.prepare("INSERT INTO contact_numbers (id, contact_id, e164) VALUES (?, ?, ?)").bind(
        crypto.randomUUID(),
        contactId,
        US,
      ),
    ]);
    await inbound();
    expect((await calls())[0]?.contact_id).toBe(contactId);
    const waiting = await owner.get<{ items: { contactName: string | null }[] }>("/api/routing/incoming");
    expect(waiting.items).toMatchObject([{ contactName: "Ada" }]);
  });

  it("sends one high-priority push per call, even with a tab open", async () => {
    const { owner } = await setup();
    const pushes = await capturePushes(owner.userId);
    await inbound();
    const sent = await pushes();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.get("urgency")).toBe("high");
    expect(Number(sent[0]?.headers.get("ttl"))).toBe(25);
  });
});

/** Posts the caller's inbound webhook and returns its TwiML. */
const inbound = async (from = US, callSid = PARENT) =>
  (await signedTwilioPost("/api/twilio/voice/inbound", { CallSid: callSid, From: from, To: OURS })).text();
const queueWait = async (queueTime: number, callSid = PARENT) =>
  (
    await signedTwilioPost("/api/twilio/voice/queue-wait", {
      CallSid: callSid,
      QueueSid: QUEUE_SID,
      QueueTime: String(queueTime),
    })
  ).text();
const queueDone = async (result: string, callSid = PARENT) =>
  (
    await signedTwilioPost("/api/twilio/voice/queue-done", {
      CallSid: callSid,
      QueueSid: QUEUE_SID,
      QueueResult: result,
    })
  ).text();
const bridge = async (dequeuer = ANSWER, callSid = PARENT) =>
  (
    await signedTwilioPost("/api/twilio/voice/queue-bridge", {
      CallSid: callSid,
      QueueSid: QUEUE_SID,
      DequeueingCallSid: dequeuer,
    })
  ).text();
const answer = async (from: string, callId: string, callSid = ANSWER) =>
  (await outbound(from, "", { AnswerCallId: callId }, callSid)).text();
const callId = async () => (await calls())[0]!.id;

const VOICEMAIL = (greeting: string) =>
  response(
    `<Say>${greeting}</Say>`,
    `<Record maxLength="120" playBeep="true" trim="trim-silence" recordingStatusCallback="https://talvuno.test/api/twilio/voice/voicemail" recordingStatusCallbackEvent="completed"/>`,
    "<Hangup/>",
  );

describe("waiting caller: ringback and ring time", () => {
  it("plays ringback until the ring time is up, then leaves the queue", async () => {
    await setup();
    await inbound();
    expect(await queueWait(0)).toBe(
      response("<Play>https://talvuno.test/sounds/ringback.wav</Play>", '<Pause length="4"/>'),
    );
    expect(await queueWait(22)).toContain('<Pause length="1"/>');
    expect(await queueWait(25)).toBe(response("<Leave/>"));
  });

  it("uses the number's own ring time", async () => {
    const { owner, numberId } = await setup();
    await owner.json("PUT", `/api/routing/numbers/${numberId}`, { ringSeconds: 40 });
    await inbound();
    expect(await queueWait(30)).toContain("<Play>");
    expect(await queueWait(40)).toBe(response("<Leave/>"));
  });

  it("sends the caller to voicemail when the ring time runs out, with the number's greeting", async () => {
    const { owner, numberId } = await setup();
    const pushes = await capturePushes(owner.userId);
    await owner.json("PUT", `/api/routing/numbers/${numberId}`, { voicemailGreeting: "Hi, leave a note" });
    await inbound();
    expect(await queueWait(25)).toBe(response("<Leave/>"));
    expect(await queueDone("leave")).toBe(VOICEMAIL("Hi, leave a note"));
    await status(PARENT, "completed", { CallDuration: "50" });
    expect(await calls()).toMatchObject([{ status: "no-answer", outcome: "voicemail", answered_at: null }]);
    const missed = await owner.get<{ items: unknown[] }>("/api/calls?filter=missed");
    expect(missed.items).toEqual([]);
    // The ringing notice only: a voicemail is never a missed call push.
    expect(await pushes()).toHaveLength(1);
  });

  it("uses the default greeting when none is set", async () => {
    await setup();
    await inbound();
    expect(await queueDone("leave")).toBe(VOICEMAIL(DEFAULT_GREETING));
  });

  it.each(["error", "queue-full", "system-error", "redirected"])(
    "sends the caller to voicemail when the queue ends with %s",
    async (result) => {
      await setup();
      await inbound();
      expect(await queueDone(result)).toBe(VOICEMAIL(DEFAULT_GREETING));
      expect(await calls()).toMatchObject([{ outcome: "voicemail" }]);
    },
  );

  it.each(["bridged", "bridging-in-process", "hangup"])(
    "ends the call when the queue ends with %s",
    async (result) => {
      await setup();
      await inbound();
      expect(await queueDone(result)).toBe(response("<Hangup/>"));
    },
  );

  it("deletes the call's queue once the caller left it", async () => {
    await setup();
    await inbound();
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      urls.push(`${init?.method ?? "GET"} ${typeof input === "string" ? input : (input as Request).url}`);
      return new Response(null, { status: 204 });
    });
    await queueDone("leave");
    await new Promise((r) => setTimeout(r, 100));
    expect(urls).toContain(
      `DELETE https://twilio.mock/2010-04-01/Accounts/AC00000000000000000000000000000000/Queues/${QUEUE_SID}.json`,
    );
  });

  it("marks a caller who hung up while waiting as missed and pushes the missed call once", async () => {
    const { owner } = await setup();
    const pushes = await capturePushes(owner.userId);
    await inbound();
    expect(await queueDone("hangup")).toBe(response("<Hangup/>"));
    await status(PARENT, "completed", { CallDuration: "9" });
    await status(PARENT, "completed", { CallDuration: "9" });
    expect(await calls()).toMatchObject([{ status: "no-answer", outcome: "missed" }]);
    const sent = await pushes();
    expect(sent).toHaveLength(2);
    const list = await owner.get<{ items: { missed: boolean }[] }>("/api/calls?filter=missed");
    expect(list.items.map((i) => i.missed)).toEqual([true]);
  });
});

describe("answering a waiting call", () => {
  it("connects the owner's device to the caller's queue, from an open or a closed app alike", async () => {
    const { owner, from } = await setup();
    const pushes = await capturePushes(owner.userId);
    await inbound();
    const [row] = await calls();
    const xml = await answer(from, row!.id);
    expect(xml).toBe(
      response(
        `<Dial timeLimit="${CALL_TIME_LIMIT_SECONDS}" action="https://talvuno.test/api/twilio/voice/hold/owner" method="POST"><Queue url="https://talvuno.test/api/twilio/voice/queue-bridge" method="POST">${row!.queue_name}</Queue></Dial>`,
      ),
    );
    // The answering leg is not a call of its own in history.
    expect(await calls()).toHaveLength(1);
    expect(await bridge()).toBe(response());
    expect(await calls()).toMatchObject([{ status: "in-progress", outcome: "answered" }]);
    expect((await calls())[0]?.answered_at).not.toBeNull();
    expect(await queueDone("bridged")).toBe(response("<Hangup/>"));
    await status(PARENT, "completed", { CallDuration: "40" });
    const [done] = await calls();
    expect(done).toMatchObject({ status: "completed", outcome: "answered" });
    expect(done?.answered_at).not.toBeNull();
    // The ringing notice only, no missed call push.
    expect(await pushes()).toHaveLength(1);
  });

  it("lets the first device win: a second device is refused and never learns the queue", async () => {
    const { from } = await setup();
    await inbound();
    const id = await callId();
    const first = await answer(from, id, ANSWER);
    expect(first).toContain("<Queue");
    // A retry of the winning leg gets the same answer.
    expect(await answer(from, id, ANSWER)).toBe(first);
    const second = await answer(from, id, ANSWER_B);
    expect(second).toBe(sayAndHangUp(SPOKEN.answeredElsewhere));
    expect(second).not.toContain((await calls())[0]!.queue_name!);
  });

  it("is owner-only: a foreign identity, another owner's call or a call that is not waiting is refused", async () => {
    const { owner, from } = await setup();
    await inbound();
    const id = await callId();
    const refused = sayAndHangUp(SPOKEN.answeredElsewhere);
    // An identity that is no owner at all.
    expect(await answer("client:owner_nobody", id)).toBe(sayAndHangUp(SPOKEN.notAllowed));
    // A second account's identity cannot pull this owner's caller.
    const otherId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Other', 'other@talvuno.test', 0, ?, ?)",
    )
      .bind(otherId, Date.now(), Date.now())
      .run();
    expect(await answer(`client:${voiceIdentity(otherId)}`, id, ANSWER_B)).toBe(refused);
    // An unknown id.
    expect(await answer(from, "no-such-call", ANSWER_B)).toBe(refused);
    // A declined call can no longer be answered.
    await owner.post(`/api/routing/incoming/${id}/decline`);
    expect(await answer(from, id, ANSWER_B)).toBe(refused);
    expect((await calls())[0]?.answer_call_sid).toBeNull();
  });

  it("never offers a call that went to voicemail", async () => {
    const { from } = await setup();
    await inbound();
    await queueDone("leave");
    expect(await answer(from, await callId())).toBe(sayAndHangUp(SPOKEN.answeredElsewhere));
  });

  it("keeps a claimed call waiting a little past the ring time for the bridge", async () => {
    const { from } = await setup();
    await inbound();
    await answer(from, await callId());
    expect(await queueWait(26)).toContain("<Play>");
    expect(await queueWait(40)).toBe(response("<Leave/>"));
  });
});

describe("declining a waiting call", () => {
  it("sends the caller to voicemail and records the call as declined", async () => {
    const { owner } = await setup();
    const pushes = await capturePushes(owner.userId);
    await inbound();
    const id = await callId();
    await owner.post(`/api/routing/incoming/${id}/decline`);
    expect(await queueWait(3)).toBe(response("<Leave/>"));
    expect(await queueDone("leave")).toBe(VOICEMAIL(DEFAULT_GREETING));
    await status(PARENT, "completed", { CallDuration: "30" });
    expect(await calls()).toMatchObject([{ status: "no-answer", outcome: "declined" }]);
    const list = await owner.get<{ items: { missed: boolean; outcome: string }[] }>("/api/calls");
    expect(list.items).toMatchObject([{ missed: false, outcome: "declined" }]);
    expect(await pushes()).toHaveLength(1);
  });

  it("cannot decline a call another device already answered", async () => {
    const { owner, from } = await setup();
    await inbound();
    const id = await callId();
    await answer(from, id);
    await owner.post(`/api/routing/incoming/${id}/decline`, {}, 409);
  });

  it("needs the owner's session", async () => {
    await setup();
    await inbound();
    const res = await new Session().fetch(`/api/routing/incoming/${await callId()}/decline`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });
});

describe("blocked callers, business hours and do not disturb", () => {
  it("rejects a blocked caller before anything rings, never as missed and never pushed", async () => {
    const { owner } = await setup();
    const pushes = await capturePushes(owner.userId);
    await owner.post("/api/routing/blocked", { address: US });
    expect(await inbound()).toBe(response('<Reject reason="rejected"/>'));
    await status(PARENT, "busy");
    expect(await calls()).toMatchObject([{ outcome: "blocked", status: "busy", queue_name: null }]);
    const list = await owner.get<{ items: { missed: boolean; outcome: string }[] }>("/api/calls");
    expect(list.items).toMatchObject([{ missed: false, outcome: "blocked" }]);
    expect((await owner.get<{ items: unknown[] }>("/api/calls?filter=missed")).items).toEqual([]);
    expect(await pushes()).toHaveLength(0);
  });

  it("keeps pushes quiet during do not disturb and outside business hours only", async () => {
    const { owner, numberId } = await setup();
    const db = createDb(env.DB);
    const noon = new Date("2026-11-09T12:00:00Z");
    expect(await quietPushNow(db, owner.userId, numberId, noon)).toBe(false);
    await owner.json("PUT", "/api/routing/dnd", { dnd: true });
    expect(await quietPushNow(db, owner.userId, numberId, noon)).toBe(true);
    await owner.json("PUT", "/api/routing/dnd", { dnd: false });
    // 2026-11-09 is a Monday (day 1): open 09:00 to 17:00 UTC.
    await owner.json("PUT", `/api/routing/numbers/${numberId}`, {
      hours: { timeZone: "UTC", days: [{ day: 1, open: "09:00", close: "17:00" }] },
    });
    expect(await quietPushNow(db, owner.userId, numberId, noon)).toBe(false);
    expect(await quietPushNow(db, owner.userId, numberId, new Date("2026-11-09T20:00:00Z"))).toBe(true);
  });

  it("rings again once the caller is unblocked", async () => {
    const { owner } = await setup();
    await owner.post("/api/routing/blocked", { address: US });
    await owner.json("DELETE", `/api/routing/blocked/${encodeURIComponent(US)}`);
    expect(await inbound()).toContain("<Enqueue");
  });

  it("sends calls outside business hours straight to voicemail, with no ring and no push", async () => {
    const { owner, numberId } = await setup();
    const pushes = await capturePushes(owner.userId);
    // Open hours on no day at all: always closed.
    await owner.json("PUT", `/api/routing/numbers/${numberId}`, {
      hours: { timeZone: "Australia/Sydney", days: [] },
    });
    expect(await inbound()).toBe(VOICEMAIL(DEFAULT_GREETING));
    await status(PARENT, "completed", { CallDuration: "20" });
    expect(await calls()).toMatchObject([{ outcome: "voicemail", queue_name: null, status: "no-answer" }]);
    expect(await pushes()).toHaveLength(0);
  });

  it("rings inside business hours", async () => {
    const { owner, numberId } = await setup();
    const days = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "00:00", close: "24:00" }));
    await owner.json("PUT", `/api/routing/numbers/${numberId}`, { hours: { timeZone: "UTC", days } });
    expect(await inbound()).toContain("<Enqueue");
  });

  it("sends every call to voicemail while do not disturb is on", async () => {
    const { owner } = await setup();
    const pushes = await capturePushes(owner.userId);
    await owner.json("PUT", "/api/routing/dnd", { dnd: true });
    expect(await inbound()).toBe(VOICEMAIL(DEFAULT_GREETING));
    expect(await calls()).toMatchObject([{ outcome: "voicemail" }]);
    expect(await pushes()).toHaveLength(0);
    await owner.json("PUT", "/api/routing/dnd", { dnd: false });
    expect(await inbound(US, CHILD)).toContain("<Enqueue");
  });
});

describe("routing settings API", () => {
  it("returns defaults, saves per number and refuses bad input and foreign numbers", async () => {
    const { owner, numberId } = await setup();
    expect(await owner.get("/api/routing")).toEqual({
      dnd: false,
      numbers: [{ numberId, ringSeconds: 25, voicemailGreeting: null, hours: null }],
    });
    const saved = await owner.json("PUT", `/api/routing/numbers/${numberId}`, {
      ringSeconds: 30,
      voicemailGreeting: "  Hello  ",
      hours: { timeZone: "Europe/London", days: [{ day: 1, open: "09:00", close: "17:00" }] },
    });
    expect(saved).toMatchObject({ ringSeconds: 30, voicemailGreeting: "Hello" });
    await owner.json("PUT", `/api/routing/numbers/${numberId}`, { ringSeconds: 5 }, 400);
    await owner.json(
      "PUT",
      `/api/routing/numbers/${numberId}`,
      { hours: { timeZone: "Mars/Olympus", days: [] } },
      400,
    );
    await owner.json(
      "PUT",
      `/api/routing/numbers/${numberId}`,
      { hours: { timeZone: "UTC", days: [{ day: 1, open: "17:00", close: "09:00" }] } },
      400,
    );
    await owner.json("PUT", `/api/routing/numbers/${crypto.randomUUID()}`, { ringSeconds: 30 }, 404);
    // An empty greeting goes back to the default.
    expect(
      await owner.json("PUT", `/api/routing/numbers/${numberId}`, { voicemailGreeting: "" }),
    ).toMatchObject({ voicemailGreeting: null, ringSeconds: 30 });
  });

  it("lists, adds twice and removes blocked numbers, and refuses withheld placeholders", async () => {
    const { owner } = await setup();
    await owner.post("/api/routing/blocked", { address: US });
    await owner.post("/api/routing/blocked", { address: US });
    await owner.post("/api/routing/blocked", { address: "ACMEBANK" });
    await owner.post("/api/routing/blocked", { address: "anonymous" }, 400);
    const list = await owner.get<{ items: { address: string }[] }>("/api/routing/blocked");
    expect(list.items.map((i) => i.address).sort()).toEqual(["+14155552671", "ACMEBANK"]);
    await owner.json("DELETE", `/api/routing/blocked/${encodeURIComponent(US)}`);
    expect((await owner.get<{ items: unknown[] }>("/api/routing/blocked")).items).toHaveLength(1);
  });

  it("lists only calls still waiting for an answer", async () => {
    const { owner, from } = await setup();
    await inbound(US, PARENT);
    await inbound(UK, CHILD);
    const waiting = await owner.get<{ items: { party: string }[] }>("/api/routing/incoming");
    expect(waiting.items.map((i) => i.party).sort()).toEqual([US, UK].sort());
    const rows = await calls();
    await answer(from, rows.find((r) => r.party === US)!.id);
    const after = await owner.get<{ items: { party: string }[] }>("/api/routing/incoming");
    expect(after.items.map((i) => i.party)).toEqual([UK]);
  });
});

describe("blocked SMS senders", () => {
  it("drops a blocked sender's text: nothing stored, shown or notified", async () => {
    const { owner } = await setup();
    const pushes = await capturePushes(owner.userId);
    await owner.post("/api/routing/blocked", { address: US });
    const res = await signedTwilioPost("/api/twilio/sms/inbound", {
      MessageSid: "SM00000000000000000000000000000001",
      From: US,
      To: OURS,
      Body: "hello",
    });
    expect(res.status).toBe(200);
    const count = async (t: string) =>
      (await env.DB.prepare(`SELECT count(*) AS n FROM ${t}`).first<{ n: number }>())?.n;
    expect(await count("messages")).toBe(0);
    expect(await count("conversations")).toBe(0);
    expect(await pushes()).toHaveLength(0);
    // Another sender still comes through.
    await signedTwilioPost("/api/twilio/sms/inbound", {
      MessageSid: "SM00000000000000000000000000000002",
      From: UK,
      To: OURS,
      Body: "hi",
    });
    expect(await count("messages")).toBe(1);
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
