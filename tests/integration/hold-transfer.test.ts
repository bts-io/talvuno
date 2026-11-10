import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallRow } from "../../src/worker/lib/voice/call-rules";
import {
  HOLD_MAX_MS,
  HOLD_MUSIC_URL,
  HOLD_SPOKEN,
  OWNER_HOLD_PAUSE_SECONDS,
  TRANSFER_MIN_SECONDS,
  TRANSFER_RING_SECONDS,
  transferTimeLimit,
} from "../../src/worker/lib/voice/hold";
import { el, response, text } from "../../src/worker/lib/voice/twiml";
import { CALL_TIME_LIMIT_SECONDS } from "../../src/worker/routes/twilio-voice";
import { createOwner, resetDb, Session } from "./helpers";
import { signedTwilioPost } from "./twilio-helpers";

beforeEach(resetDb);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ORIGIN = "https://talvuno.test";
const HOLD = `${ORIGIN}/api/twilio/voice/hold`;
const OURS = "+14155550100";
const US = "+14155552671";
const US_2 = "+14155552672";
const UK = "+447911123456";
const PARENT = "CA00000000000000000000000000000001";
const CHILD = "CA00000000000000000000000000000002";
const ANSWER = "CA00000000000000000000000000000009";
const QUEUE_SID = "QU00000000000000000000000000000001";

type Sent = { method: string; path: string; form: Record<string, string> };

/** Answers Twilio REST like Twilio would and keeps every request. `fail` makes call updates fail. */
function mockTwilio(opts: { fail?: { status: number; code?: number }; children?: string[] } = {}) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input instanceof Request ? input.url : input));
      const method = init?.method ?? "GET";
      const form = Object.fromEntries(new URLSearchParams(typeof init?.body === "string" ? init.body : ""));
      const path = u.pathname.replace(/^\/2010-04-01\/Accounts\/[^/]+/, "");
      sent.push({ method, path: method === "GET" ? `${path}${u.search}` : path, form });
      if (method === "GET" && path === "/Calls.json")
        return Response.json({
          calls: (opts.children ?? [CHILD]).map((sid) => ({ sid, status: "in-progress" })),
        });
      if (method === "POST" && opts.fail)
        return Response.json({ code: opts.fail.code, message: "nope" }, { status: opts.fail.status });
      if (method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ sid: "CA0" });
    }),
  );
  const posts = () => sent.filter((s) => s.method === "POST");
  return { sent, posts };
}

async function addNumber(ownerId: string, e164: string) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO phone_numbers (id, owner_id, e164, twilio_sid, friendly_name, capabilities, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, 1, ?, ?)",
  )
    .bind(
      id,
      ownerId,
      e164,
      `PN${"1".padStart(32, "0")}`,
      JSON.stringify({ voice: true, sms: true, mms: false }),
      1,
      1,
    )
    .run();
  return id;
}

async function allow(ownerId: string, countries: string[]) {
  await env.DB.prepare(
    "INSERT INTO user_preferences (user_id, country_allowlist, calls_per_hour, updated_at) VALUES (?, ?, 20, ?) ON CONFLICT(user_id) DO UPDATE SET country_allowlist = excluded.country_allowlist, calls_per_hour = 20",
  )
    .bind(ownerId, JSON.stringify(countries), Date.now())
    .run();
}

type Live = { direction: "inbound" | "outbound"; ended?: boolean; answered?: boolean; onHoldAt?: number };

/** A live, answered call row: outbound keyed by the browser leg, inbound by the caller with ANSWER claiming it. */
async function liveCall(ownerId: string, numberId: string | null, l: Live) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO calls (id, owner_id, twilio_call_sid, direction, number_id, party, status, started_at, answered_at,
       ended_at, answer_call_sid, on_hold_at, hold_queue, outcome, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      ownerId,
      PARENT,
      l.direction,
      numberId,
      US,
      l.ended ? "completed" : "in-progress",
      now - 60_000,
      l.answered === false ? null : now - 50_000,
      l.ended ? now : null,
      l.direction === "inbound" ? ANSWER : null,
      l.onHoldAt ?? null,
      l.onHoldAt ? "th_existing" : null,
      l.direction === "inbound" ? "answered" : null,
      now,
      now,
    )
    .run();
  return id;
}

type Row = {
  id: string;
  on_hold_at: number | null;
  hold_queue: string | null;
  remote_call_sid: string | null;
  transferred_to: string | null;
  status: string;
  ended_at: number | null;
  duration: number | null;
  outcome: string | null;
  transfer_status: string | null;
  transfer_duration: number | null;
  transfer_ended_at: number | null;
};
const row = async () => (await env.DB.prepare("SELECT * FROM calls").first<Row>())!;

async function setup(l: Live = { direction: "outbound" }) {
  const owner = await createOwner();
  const numberId = await addNumber(owner.userId, OURS);
  await allow(owner.userId, ["US"]);
  const id = await liveCall(owner.userId, numberId, l);
  return { owner, numberId, id };
}

const enqueue = (queue: string) =>
  response(
    el(
      "Enqueue",
      { action: `${HOLD}/done`, method: "POST", waitUrl: `${HOLD}/wait`, waitUrlMethod: "POST" },
      text(queue),
    ),
  );

describe("POST /api/calls/:ref/hold", () => {
  it("moves the dialed party of an outbound call into a hold queue of its own", async () => {
    const { owner } = await setup();
    const tw = mockTwilio();
    const body = await owner.post(`/api/calls/${PARENT}/hold`);
    const r = await row();
    expect(body).toEqual({ id: r.id, onHold: true, transferredTo: null });
    expect(r.on_hold_at).toBeTypeOf("number");
    expect(r.hold_queue).toMatch(/^th_[0-9a-f]{32}$/);
    expect(r.remote_call_sid).toBe(CHILD);
    expect(tw.sent[0]!.path).toContain(`/Calls.json?ParentCallSid=${PARENT}&Status=in-progress`);
    expect(tw.posts()).toEqual([
      { method: "POST", path: `/Calls/${CHILD}.json`, form: { Twiml: enqueue(r.hold_queue!) } },
    ]);
  });

  it("moves the caller of an inbound call, found by the answering leg's CallSid", async () => {
    const { owner } = await setup({ direction: "inbound" });
    const tw = mockTwilio();
    await owner.post(`/api/calls/${ANSWER}/hold`);
    expect(tw.posts().map((p) => p.path)).toEqual([`/Calls/${PARENT}.json`]);
    expect(tw.sent.some((s) => s.method === "GET")).toBe(false);
  });

  it("is idempotent: holding a held call changes nothing", async () => {
    const { owner, id } = await setup();
    mockTwilio();
    await owner.post(`/api/calls/${id}/hold`);
    const first = await row();
    const tw = mockTwilio();
    expect(await owner.post(`/api/calls/${id}/hold`)).toMatchObject({ onHold: true });
    expect(tw.sent).toEqual([]);
    expect((await row()).hold_queue).toBe(first.hold_queue);
  });

  it("refuses calls that are not live", async () => {
    const { owner, id } = await setup({ direction: "outbound", ended: true });
    const tw = mockTwilio();
    expect((await owner.post(`/api/calls/${id}/hold`, {}, 409)).error).toBe("not_live");
    expect(tw.sent).toEqual([]);
  });

  it("refuses a call not answered yet", async () => {
    const { owner, id } = await setup({ direction: "outbound", answered: false });
    mockTwilio();
    expect((await owner.post(`/api/calls/${id}/hold`, {}, 409)).error).toBe("not_live");
  });

  it("needs the owner's session", async () => {
    const { id } = await setup();
    const tw = mockTwilio();
    for (const action of ["hold", "resume", "transfer"]) {
      const res = await new Session().fetch(`/api/calls/${id}/${action}`, {
        method: "POST",
        json: { to: US_2 },
      });
      expect(res.status).toBe(401);
    }
    expect(tw.sent).toEqual([]);
  });

  it("puts the row back when Twilio refuses the redirect", async () => {
    const { owner, id } = await setup();
    mockTwilio({ fail: { status: 500 } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await owner.post(`/api/calls/${id}/hold`, {}, 502)).error).toBe("twilio_failed");
    expect((await row()).on_hold_at).toBeNull();
  });
});

describe("another owner's call", () => {
  it("is not found", async () => {
    const { owner, id } = await setup();
    await env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('u2', 'B', 'b@x.test', 0, 1, 1)",
    ).run();
    await env.DB.prepare("UPDATE calls SET owner_id = 'u2', number_id = NULL").run();
    const tw = mockTwilio();
    for (const action of ["hold", "resume"])
      expect((await owner.post(`/api/calls/${id}/${action}`, {}, 404)).error).toBe("not_found");
    expect((await owner.post(`/api/calls/${id}/transfer`, { to: US_2 }, 404)).error).toBe("not_found");
    expect(tw.sent).toEqual([]);
  });
});

describe("POST /api/calls/:ref/resume", () => {
  const resume = (queue: string) =>
    response(
      el(
        "Dial",
        { timeLimit: CALL_TIME_LIMIT_SECONDS, action: `${HOLD}/owner`, method: "POST" },
        el("Queue", { url: `${HOLD}/bridge`, method: "POST" }, text(queue)),
      ),
    );

  it("redirects the owner's browser leg into the hold queue (outbound: the row's own leg)", async () => {
    const { owner, id } = await setup({ direction: "outbound", onHoldAt: Date.now() });
    const tw = mockTwilio();
    expect(await owner.post(`/api/calls/${id}/resume`)).toMatchObject({ onHold: false });
    expect(tw.posts()).toEqual([
      { method: "POST", path: `/Calls/${PARENT}.json`, form: { Twiml: resume("th_existing") } },
    ]);
    expect((await row()).on_hold_at).toBeNull();
  });

  it("redirects the answering leg of an inbound call", async () => {
    const { owner, id } = await setup({ direction: "inbound", onHoldAt: Date.now() });
    const tw = mockTwilio();
    await owner.post(`/api/calls/${id}/resume`);
    expect(tw.posts().map((p) => p.path)).toEqual([`/Calls/${ANSWER}.json`]);
  });

  it("is idempotent: resuming a call that is not held changes nothing", async () => {
    const { owner, id } = await setup();
    const tw = mockTwilio();
    expect(await owner.post(`/api/calls/${id}/resume`)).toMatchObject({ onHold: false });
    expect(tw.sent).toEqual([]);
  });

  it("keeps the hold when the browser leg is gone", async () => {
    const at = Date.now() - 1000;
    const { owner, id } = await setup({ direction: "outbound", onHoldAt: at });
    mockTwilio({ fail: { status: 400, code: 21220 } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await owner.post(`/api/calls/${id}/resume`, {}, 409)).error).toBe("owner_leg_ended");
    expect((await row()).on_hold_at).toBe(at);
  });
});

describe("POST /api/calls/:ref/transfer", () => {
  // The fixture call was answered 50 seconds ago, so the transfer gets what is left of the call's limit.
  const transfer = (to: string, id: string) =>
    response(
      el(
        "Dial",
        {
          callerId: OURS,
          timeLimit: CALL_TIME_LIMIT_SECONDS - 50,
          timeout: TRANSFER_RING_SECONDS,
          answerOnBridge: true,
          action: `${HOLD}/transfer-done?call=${id}`,
          method: "POST",
        },
        el(
          "Number",
          {
            statusCallback: `${HOLD}/transfer-status?call=${id}`,
            statusCallbackEvent: "completed",
            statusCallbackMethod: "POST",
          },
          text(to),
        ),
      ),
    );

  it("dials the target from the call's number on the other party's leg, then ends the owner's leg", async () => {
    const { owner, id } = await setup();
    const tw = mockTwilio();
    expect(await owner.post(`/api/calls/${id}/transfer`, { to: US_2 })).toEqual({
      id,
      onHold: false,
      transferredTo: US_2,
    });
    expect(tw.posts()).toEqual([
      { method: "POST", path: `/Calls/${CHILD}.json`, form: { Twiml: transfer(US_2, id) } },
      { method: "POST", path: `/Calls/${PARENT}.json`, form: { Status: "completed" } },
    ]);
    expect((await row()).transferred_to).toBe(US_2);
    const list = await owner.get("/api/calls");
    expect(list.items[0]).toMatchObject({ transferredTo: US_2 });
  });

  it("works for an inbound call: the caller is redirected, the answering leg ends", async () => {
    const { owner, id } = await setup({ direction: "inbound" });
    const tw = mockTwilio();
    await owner.post(`/api/calls/${id}/transfer`, { to: US_2 });
    expect(tw.posts().map((p) => p.path)).toEqual([`/Calls/${PARENT}.json`, `/Calls/${ANSWER}.json`]);
  });

  it("refuses a number outside the allowlist without touching Twilio", async () => {
    const { owner, id } = await setup();
    const tw = mockTwilio();
    expect((await owner.post(`/api/calls/${id}/transfer`, { to: UK }, 403)).error).toBe(
      "country_not_allowed",
    );
    expect(tw.sent).toEqual([]);
    expect((await row()).transferred_to).toBeNull();
  });

  it("refuses an invalid number and one of the owner's own numbers", async () => {
    const { owner, id } = await setup();
    const tw = mockTwilio();
    expect((await owner.post(`/api/calls/${id}/transfer`, { to: "12" }, 400)).error).toBe("invalid_number");
    expect((await owner.post(`/api/calls/${id}/transfer`, { to: OURS }, 400)).error).toBe("own_number");
    expect(tw.sent).toEqual([]);
  });

  it("is idempotent for the same target and refuses a second target", async () => {
    const { owner, id } = await setup();
    mockTwilio();
    await owner.post(`/api/calls/${id}/transfer`, { to: US_2 });
    const tw = mockTwilio();
    expect(await owner.post(`/api/calls/${id}/transfer`, { to: US_2 })).toMatchObject({
      transferredTo: US_2,
    });
    expect((await owner.post(`/api/calls/${id}/transfer`, { to: US }, 409)).error).toBe(
      "already_transferred",
    );
    expect(tw.sent).toEqual([]);
  });

  it("refuses an ended call", async () => {
    const { owner, id } = await setup({ direction: "outbound", ended: true });
    mockTwilio();
    expect((await owner.post(`/api/calls/${id}/transfer`, { to: US_2 }, 409)).error).toBe("not_live");
  });

  it("undoes the record when Twilio refuses", async () => {
    const { owner, id } = await setup();
    mockTwilio({ fail: { status: 500 } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await owner.post(`/api/calls/${id}/transfer`, { to: US_2 }, 502)).error).toBe("twilio_failed");
    expect((await row()).transferred_to).toBeNull();
  });
});

describe("hold webhooks", () => {
  const wait = (queueTime: number, sid = PARENT) =>
    signedTwilioPost("/api/twilio/voice/hold/wait", {
      CallSid: sid,
      QueueSid: QUEUE_SID,
      QueueTime: String(queueTime),
    });
  const done = (result: string, sid = PARENT) =>
    signedTwilioPost("/api/twilio/voice/hold/done", {
      CallSid: sid,
      QueueSid: QUEUE_SID,
      QueueResult: result,
    });
  const ownerLoop = (sid: string) => signedTwilioPost("/api/twilio/voice/hold/owner", { CallSid: sid });

  it("plays hold music while held, and leaves after ten minutes", async () => {
    const { owner } = await setup({ direction: "inbound", onHoldAt: Date.now() });
    expect(owner).toBeTruthy();
    expect(await (await wait(30)).text()).toBe(response(el("Play", {}, text(HOLD_MUSIC_URL))));
    expect(await (await wait(HOLD_MAX_MS / 1000)).text()).toBe(response(el("Leave")));
    await env.DB.prepare("UPDATE calls SET on_hold_at = ?")
      .bind(Date.now() - HOLD_MAX_MS - 1)
      .run();
    expect(await (await wait(1)).text()).toBe(response(el("Leave")));
  });

  it("finds the outbound party by its own leg", async () => {
    await setup({ direction: "outbound", onHoldAt: Date.now() });
    await env.DB.prepare("UPDATE calls SET remote_call_sid = ?").bind(CHILD).run();
    expect(await (await wait(1, CHILD)).text()).toContain("<Play>");
    // An unknown leg never waits.
    expect(await (await wait(1, ANSWER)).text()).toBe(response(el("Leave")));
  });

  it("ends a timed out hold with a spoken message and deletes the queue", async () => {
    await setup({ direction: "inbound", onHoldAt: Date.now() - HOLD_MAX_MS });
    const tw = mockTwilio();
    expect(await (await done("leave")).text()).toBe(
      response(el("Say", {}, text(HOLD_SPOKEN.timedOut)), el("Hangup")),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(tw.sent).toContainEqual({ method: "DELETE", path: `/Queues/${QUEUE_SID}.json`, form: {} });
  });

  it("does nothing after our own redirect, and hangs up when the bridge ends", async () => {
    await setup({ direction: "inbound" });
    mockTwilio();
    expect(await (await done("redirected-from-bridged")).text()).toBe(response());
    expect(await (await done("bridged")).text()).toBe(response(el("Hangup")));
    expect(await (await done("hangup")).text()).toBe(response(el("Hangup")));
  });

  it("keeps the owner's leg on silence while held, and hangs it up otherwise", async () => {
    await setup({ direction: "inbound", onHoldAt: Date.now() });
    expect(await (await ownerLoop(ANSWER)).text()).toBe(
      response(
        el("Pause", { length: OWNER_HOLD_PAUSE_SECONDS }),
        el("Redirect", { method: "POST" }, text(`${HOLD}/owner`)),
      ),
    );
    // The caller's own leg is not the owner's leg.
    expect(await (await ownerLoop(PARENT)).text()).toBe(response(el("Hangup")));
    await env.DB.prepare("UPDATE calls SET on_hold_at = NULL").run();
    expect(await (await ownerLoop(ANSWER)).text()).toBe(response(el("Hangup")));
  });

  it("tells the transferred party when the target did not answer", async () => {
    const res = await signedTwilioPost("/api/twilio/voice/hold/transfer-done", {
      CallSid: PARENT,
      DialCallStatus: "no-answer",
    });
    expect(await res.text()).toBe(response(el("Say", {}, text(HOLD_SPOKEN.transferFailed)), el("Hangup")));
    const ok = await signedTwilioPost("/api/twilio/voice/hold/transfer-done", {
      CallSid: PARENT,
      DialCallStatus: "completed",
    });
    expect(await ok.text()).toBe(response(el("Hangup")));
  });

  it("refuses unsigned requests", async () => {
    const res = await signedTwilioPost(
      "/api/twilio/voice/hold/owner",
      { CallSid: ANSWER },
      { signature: null },
    );
    expect(res.status).toBe(403);
  });
});

describe("existing call webhooks around a hold", () => {
  it("an outbound <Dial> ended by the hold keeps the row open and the browser on silence", async () => {
    await setup({ direction: "outbound", onHoldAt: Date.now() });
    const res = await signedTwilioPost("/api/twilio/voice/outbound-complete", {
      CallSid: PARENT,
      DialCallStatus: "completed",
    });
    expect(await res.text()).toContain(`<Redirect method="POST">${HOLD}/owner</Redirect>`);
    expect(await row()).toMatchObject({ status: "in-progress", ended_at: null });
  });

  it("an outbound <Dial> ended by a transfer hangs up the browser and keeps the row open", async () => {
    await setup({ direction: "outbound" });
    await env.DB.prepare("UPDATE calls SET transferred_to = ?").bind(US_2).run();
    const res = await signedTwilioPost("/api/twilio/voice/outbound-complete", {
      CallSid: PARENT,
      DialCallStatus: "completed",
    });
    expect(await res.text()).toBe(response(el("Hangup")));
    expect((await row()).ended_at).toBeNull();
  });

  it("the caller's first queue does not send a held caller to voicemail", async () => {
    await setup({ direction: "inbound", onHoldAt: Date.now() });
    mockTwilio();
    const res = await signedTwilioPost("/api/twilio/voice/queue-done", {
      CallSid: PARENT,
      QueueSid: QUEUE_SID,
      QueueResult: "redirected-from-bridged",
    });
    expect(await res.text()).toBe(response());
  });
});

describe("the owner leaves while the other party is on hold", () => {
  const goodbye = response(el("Say", {}, text(HOLD_SPOKEN.ownerLeft)), el("Hangup"));
  /** The browser leg's final status callback (browser legs are never children). */
  const browserEnded = (sid: string) =>
    signedTwilioPost("/api/twilio/voice/status", {
      CallSid: sid,
      CallStatus: "completed",
      CallDuration: "70",
    });

  it("inbound: the answering leg ending lets the caller go at once and closes the row as answered", async () => {
    await setup({ direction: "inbound", onHoldAt: Date.now() - 5_000 });
    const tw = mockTwilio();
    expect((await browserEnded(ANSWER)).status).toBe(200);
    expect(tw.posts()).toEqual([{ method: "POST", path: `/Calls/${PARENT}.json`, form: { Twiml: goodbye } }]);
    const r = await row();
    expect(r).toMatchObject({ status: "completed", outcome: "answered" });
    expect(r.ended_at).toBeTypeOf("number");
    expect(r.duration).toBeGreaterThanOrEqual(50);
    // The hold queue's wait URL now lets the caller go too, should the redirect be late.
    const wait = await signedTwilioPost("/api/twilio/voice/hold/wait", {
      CallSid: PARENT,
      QueueSid: QUEUE_SID,
      QueueTime: "5",
    });
    expect(await wait.text()).toBe(response(el("Leave")));
  });

  it("outbound: the browser leg ending lets the dialed party go and closes the row", async () => {
    await setup({ direction: "outbound", onHoldAt: Date.now() - 5_000 });
    await env.DB.prepare("UPDATE calls SET remote_call_sid = ?").bind(CHILD).run();
    const tw = mockTwilio();
    await browserEnded(PARENT);
    expect(tw.posts()).toEqual([{ method: "POST", path: `/Calls/${CHILD}.json`, form: { Twiml: goodbye } }]);
    const r = await row();
    expect(r.status).toBe("completed");
    expect(r.ended_at).toBeTypeOf("number");
    expect(r.duration).toBeGreaterThanOrEqual(50);
  });

  it("a duplicate callback, or the callback after the hang-up request, changes nothing", async () => {
    const { owner } = await setup({ direction: "inbound", onHoldAt: Date.now() });
    const tw = mockTwilio();
    expect(await owner.post(`/api/calls/${ANSWER}/hangup`)).toMatchObject({ onHold: false });
    await browserEnded(ANSWER);
    await browserEnded(ANSWER);
    expect(tw.posts()).toHaveLength(1);
    const events = await env.DB.prepare(
      "SELECT count(*) AS n FROM webhook_events WHERE idempotency_key LIKE 'hold-end:%' AND processed_at IS NOT NULL",
    ).first<{ n: number }>();
    expect(events?.n).toBe(1);
  });

  it("the hang-up request ends a held outbound call, and leaves a call that is not held to the browser", async () => {
    const { owner, id } = await setup({ direction: "outbound" });
    const tw = mockTwilio();
    expect(await owner.post(`/api/calls/${id}/hangup`)).toEqual({ id, onHold: false, transferredTo: null });
    expect(tw.sent).toEqual([]);
    expect((await row()).ended_at).toBeNull();
    await env.DB.prepare("UPDATE calls SET on_hold_at = ?, remote_call_sid = ?")
      .bind(Date.now(), CHILD)
      .run();
    await owner.post(`/api/calls/${PARENT}/hangup`);
    expect(tw.posts()).toEqual([{ method: "POST", path: `/Calls/${CHILD}.json`, form: { Twiml: goodbye } }]);
    expect((await row()).status).toBe("completed");
  });

  it("closes the row even when the held party already hung up", async () => {
    await setup({ direction: "inbound", onHoldAt: Date.now() });
    mockTwilio({ fail: { status: 404, code: 20404 } });
    expect((await browserEnded(ANSWER)).status).toBe(200);
    expect((await row()).status).toBe("completed");
  });

  it("a transferred call is not ended by the owner's leg", async () => {
    await setup({ direction: "inbound", onHoldAt: Date.now() });
    await env.DB.prepare("UPDATE calls SET transferred_to = ?").bind(US_2).run();
    const tw = mockTwilio();
    await browserEnded(ANSWER);
    expect(tw.sent).toEqual([]);
    expect((await row()).ended_at).toBeNull();
  });
});

describe("the transfer leg", () => {
  const transferStatus = (
    id: string,
    status: string,
    duration: string,
    sid = "CA00000000000000000000000000000077",
  ) =>
    signedTwilioPost(`/api/twilio/voice/hold/transfer-status?call=${id}`, {
      CallSid: sid,
      ParentCallSid: PARENT,
      CallStatus: status,
      CallDuration: duration,
    });

  async function transferred() {
    const s = await setup({ direction: "inbound" });
    await env.DB.prepare("UPDATE calls SET transferred_to = ?, transferred_at = ?")
      .bind(US_2, Date.now())
      .run();
    return s;
  }

  it("records the target's result and talk time on the call row", async () => {
    const { owner, id } = await transferred();
    expect((await transferStatus(id, "completed", "42")).status).toBe(200);
    const r = await row();
    expect(r).toMatchObject({ transfer_status: "completed", transfer_duration: 42 });
    expect(r.transfer_ended_at).toBeTypeOf("number");
    const list = await owner.get("/api/calls");
    expect(list.items[0]).toMatchObject({
      transferredTo: US_2,
      transferStatus: "completed",
      transferDuration: 42,
    });
  });

  it("the <Dial action> records a target that did not answer, and the first report wins", async () => {
    const { id } = await transferred();
    const res = await signedTwilioPost(`/api/twilio/voice/hold/transfer-done?call=${id}`, {
      CallSid: PARENT,
      DialCallSid: "CA00000000000000000000000000000077",
      DialCallStatus: "no-answer",
    });
    expect(await res.text()).toBe(response(el("Say", {}, text(HOLD_SPOKEN.transferFailed)), el("Hangup")));
    expect(await row()).toMatchObject({ transfer_status: "no-answer", transfer_duration: 0 });
    await transferStatus(id, "completed", "42");
    expect(await row()).toMatchObject({ transfer_status: "no-answer", transfer_duration: 0 });
  });

  it("a duplicate status callback is recorded once, and a call never transferred is left alone", async () => {
    const { id } = await transferred();
    await transferStatus(id, "busy", "0");
    await transferStatus(id, "busy", "0");
    const events = await env.DB.prepare(
      "SELECT count(*) AS n, max(attempts) AS attempts FROM webhook_events WHERE type = 'hold-transfer-end'",
    ).first<{ n: number; attempts: number }>();
    expect(events?.n).toBe(1);
    await env.DB.prepare(
      "UPDATE calls SET transferred_to = NULL, transfer_status = NULL, transfer_ended_at = NULL",
    ).run();
    await transferStatus(id, "completed", "9", "CA00000000000000000000000000000078");
    expect((await row()).transfer_status).toBeNull();
  });

  it("is bounded by what is left of the call's limit, never below a minute", () => {
    const answeredAt = new Date(1_000_000);
    const at = (s: number) => 1_000_000 + s * 1000;
    const r = { answeredAt } as CallRow;
    expect(transferTimeLimit(r, CALL_TIME_LIMIT_SECONDS, at(600))).toBe(CALL_TIME_LIMIT_SECONDS - 600);
    expect(transferTimeLimit(r, CALL_TIME_LIMIT_SECONDS, at(CALL_TIME_LIMIT_SECONDS))).toBe(
      TRANSFER_MIN_SECONDS,
    );
    expect(transferTimeLimit({ answeredAt: null } as CallRow, CALL_TIME_LIMIT_SECONDS)).toBe(
      CALL_TIME_LIMIT_SECONDS,
    );
  });
});

describe("recording attributes on hold and transfer", () => {
  const recordOn = (owner: Session, numberId: string) =>
    owner.json("PUT", `/api/recordings/settings/${numberId}`, {
      recordCalls: true,
      playNotice: false,
      noticeText: null,
    });

  it("resume carries the recording attributes of a recorded call, and none when it is not recorded", async () => {
    const { owner, numberId, id } = await setup({ direction: "outbound", onHoldAt: Date.now() });
    let tw = mockTwilio();
    await owner.post(`/api/calls/${id}/resume`);
    expect(tw.posts()[0]!.form.Twiml).not.toContain("record");

    await env.DB.prepare("UPDATE calls SET on_hold_at = ?, hold_queue = 'th_existing'")
      .bind(Date.now())
      .run();
    await recordOn(owner, numberId);
    tw = mockTwilio();
    await owner.post(`/api/calls/${id}/resume`);
    const twiml = tw.posts()[0]!.form.Twiml!;
    expect(twiml).toContain('record="record-from-answer-dual"');
    expect(twiml).toContain(`recordingStatusCallback="${ORIGIN}/api/twilio/voice/recording"`);
    expect(twiml).toContain('recordingStatusCallbackEvent="completed"');
  });

  it("a transfer of a recorded call carries no recording attributes", async () => {
    const { owner, numberId, id } = await setup();
    await recordOn(owner, numberId);
    const tw = mockTwilio();
    await owner.post(`/api/calls/${id}/transfer`, { to: US_2 });
    const twiml = tw.posts()[0]!.form.Twiml!;
    expect(twiml).toContain("<Number");
    expect(twiml).not.toContain("record");
  });
});
