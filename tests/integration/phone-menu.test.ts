import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NumberMenuInput } from "../../src/contracts/menus";
import { FORWARD_REFUSED } from "../../src/worker/lib/voice/menu";
import { DEFAULT_GREETING } from "../../src/worker/lib/voice/routing";
import { response } from "../../src/worker/lib/voice/twiml";
import { createOwner, resetDb } from "./helpers";
import { signedTwilioPost } from "./twilio-helpers";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const OURS = "+14155550100";
const US = "+14155552671";
const US_2 = "+14155552672";
const UK = "+447911123456";
const PARENT = "CA00000000000000000000000000000001";
const CHILD = "CA00000000000000000000000000000002";
const BASE = "https://talvuno.test/api/twilio/voice";

let seq = 0;
async function addNumber(ownerId: string, e164: string) {
  const id = crypto.randomUUID();
  seq++;
  await env.DB.prepare(
    "INSERT INTO phone_numbers (id, owner_id, e164, twilio_sid, friendly_name, capabilities, is_default, released_at, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, 1, NULL, ?, ?)",
  )
    .bind(
      id,
      ownerId,
      e164,
      `PN${String(seq).padStart(32, "0")}`,
      JSON.stringify({ voice: true, sms: true, mms: false }),
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

type Row = {
  id: string;
  status: string;
  outcome: string | null;
  queue_name: string | null;
  answered_at: number | null;
  forwarded_to: string | null;
  duration: number | null;
};
const calls = async () =>
  (await env.DB.prepare("SELECT * FROM calls ORDER BY created_at").all<Row>()).results;

const MENU: NumberMenuInput = {
  enabled: true,
  prompt: "Press 1 for us, 2 for a message, 3 for the office.",
  keys: [
    { digit: "1", action: "ring" },
    { digit: "2", action: "voicemail" },
    { digit: "3", action: "forward", to: US_2 },
  ],
  defaultAction: "voicemail",
};

async function setup(menu: NumberMenuInput | null = MENU, opts: { callsPerHour?: number } = {}) {
  const owner = await createOwner();
  const numberId = await addNumber(owner.userId, OURS);
  await allow(owner.userId, ["US"], opts.callsPerHour);
  if (menu) await owner.json("PUT", `/api/menus/numbers/${numberId}`, menu);
  return { owner, numberId };
}

const inbound = async (callSid = PARENT, from = US) =>
  (await signedTwilioPost("/api/twilio/voice/inbound", { CallSid: callSid, From: from, To: OURS })).text();

const press = async (digits: string, attempt = 1, callSid = PARENT) =>
  (
    await signedTwilioPost(`/api/twilio/voice/menu-choice?attempt=${attempt}`, {
      CallSid: callSid,
      ...(digits ? { Digits: digits } : {}),
    })
  ).text();

const forwardDone = async (dialStatus: string, extra: Record<string, string> = {}) =>
  (
    await signedTwilioPost("/api/twilio/voice/menu-forward-done", {
      CallSid: PARENT,
      DialCallStatus: dialStatus,
      ...extra,
    })
  ).text();

const status = (callSid: string, callStatus: string, extra: Record<string, string> = {}) =>
  signedTwilioPost("/api/twilio/voice/status", { CallSid: callSid, CallStatus: callStatus, ...extra });

const GATHER = (prompt: string, attempt: number) =>
  response(
    `<Gather input="dtmf" numDigits="1" timeout="6" action="${BASE}/menu-choice?attempt=${attempt}" method="POST" actionOnEmptyResult="true"><Say>${prompt}</Say></Gather>`,
  );

const VOICEMAIL = (greeting: string, notice?: string) =>
  response(
    ...(notice ? [`<Say>${notice}</Say>`] : []),
    `<Say>${greeting}</Say>`,
    `<Record maxLength="120" playBeep="true" trim="trim-silence" recordingStatusCallback="${BASE}/voicemail" recordingStatusCallbackEvent="completed"/>`,
    "<Hangup/>",
  );

const FORWARD = (to: string) =>
  response(
    `<Dial callerId="${OURS}" timeLimit="7200" action="${BASE}/menu-forward-done" method="POST"><Number statusCallback="${BASE}/status" statusCallbackEvent="initiated ringing answered completed" statusCallbackMethod="POST">${to}</Number></Dial>`,
  );

describe("phone menu: where it sits in the inbound flow", () => {
  it("rings as before when the number has no menu, or the menu is off", async () => {
    const { owner, numberId } = await setup(null);
    expect(await inbound()).toContain("<Enqueue");
    await owner.json("PUT", `/api/menus/numbers/${numberId}`, { ...MENU, enabled: false });
    expect(await inbound("CA00000000000000000000000000000003")).toContain("<Enqueue");
  });

  it("plays the menu before the queue: nothing rings and the row waits without a queue", async () => {
    const { owner } = await setup();
    expect(await inbound()).toBe(GATHER(MENU.prompt, 1));
    expect(await calls()).toMatchObject([{ status: "ringing", outcome: null, queue_name: null }]);
    expect((await owner.get<{ items: unknown[] }>("/api/routing/incoming")).items).toEqual([]);
    // A retry of the inbound webhook plays the menu again, it never queues.
    expect(await inbound()).toBe(GATHER(MENU.prompt, 1));
    expect(await calls()).toHaveLength(1);
  });

  it("still rejects blocked callers first", async () => {
    const { owner } = await setup();
    await owner.post("/api/routing/blocked", { address: US });
    expect(await inbound()).toBe(response('<Reject reason="rejected"/>'));
    expect(await calls()).toMatchObject([{ outcome: "blocked" }]);
  });

  it("still sends calls to voicemail during do not disturb and outside hours, before the menu", async () => {
    const { owner, numberId } = await setup();
    await owner.json("PUT", "/api/routing/dnd", { dnd: true });
    expect(await inbound()).toBe(VOICEMAIL(DEFAULT_GREETING));
    await owner.json("PUT", "/api/routing/dnd", { dnd: false });
    await owner.json("PUT", `/api/routing/numbers/${numberId}`, { hours: { timeZone: "UTC", days: [] } });
    expect(await inbound(CHILD)).toBe(VOICEMAIL(DEFAULT_GREETING));
    expect((await calls()).map((r) => r.outcome)).toEqual(["voicemail", "voicemail"]);
  });

  it("ignores a menu row that belongs to another owner", async () => {
    const { owner } = await setup(null);
    const other = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Other', 'other@talvuno.test', 0, ?, ?)",
    )
      .bind(other, Date.now(), Date.now())
      .run();
    const numberId = (await owner.get<{ items: { numberId: string }[] }>("/api/menus")).items[0]!.numberId;
    await env.DB.prepare(
      "INSERT INTO number_menus (id, owner_id, number_id, enabled, prompt, keys, default_action, updated_at) VALUES (?, ?, ?, 1, 'Hi', ?, 'ring', ?)",
    )
      .bind(
        crypto.randomUUID(),
        other,
        numberId,
        JSON.stringify([{ digit: "1", action: "ring" }]),
        Date.now(),
      )
      .run();
    expect(await inbound()).toContain("<Enqueue");
  });
});

describe("phone menu: keys", () => {
  it("rings the app on a ring key: the call joins its queue and shows as waiting", async () => {
    const { owner } = await setup();
    await inbound();
    const xml = await press("1");
    expect(xml).toContain("<Enqueue");
    const [row] = await calls();
    expect(row!.queue_name).toMatch(/^tq_/);
    expect(xml).toContain(row!.queue_name!);
    expect((await owner.get<{ items: unknown[] }>("/api/routing/incoming")).items).toHaveLength(1);
    // The same key again (a Twilio retry) joins the same queue.
    expect(await press("1")).toBe(xml);
  });

  it("goes straight to voicemail on a voicemail key", async () => {
    await setup();
    await inbound();
    expect(await press("2")).toBe(VOICEMAIL(DEFAULT_GREETING));
    expect(await calls()).toMatchObject([{ outcome: "voicemail", queue_name: null }]);
  });

  it("forwards from the called number, records the leg on the same row and never counts it missed", async () => {
    const { owner } = await setup();
    await inbound();
    expect(await press("3")).toBe(FORWARD(US_2));
    expect(await calls()).toMatchObject([{ outcome: "forwarded" }]);
    for (const st of ["initiated", "ringing", "in-progress"])
      expect((await status(CHILD, st, { ParentCallSid: PARENT })).status).toBe(200);
    expect(await forwardDone("completed", { DialCallDuration: "42" })).toBe(response("<Hangup/>"));
    await status(PARENT, "completed", { CallDuration: "50" });
    const rows = await calls();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "completed", outcome: "forwarded", duration: 42 });
    expect(rows[0]!.answered_at).not.toBeNull();
    const list = await owner.get<{ items: { missed: boolean; outcome: string }[] }>("/api/calls");
    expect(list.items).toMatchObject([{ missed: false, outcome: "forwarded" }]);
  });

  it("offers voicemail when the forwarded number does not answer, and the call ends as voicemail", async () => {
    const { owner } = await setup();
    await inbound();
    await press("3");
    expect(await forwardDone("no-answer")).toBe(VOICEMAIL(DEFAULT_GREETING));
    await status(PARENT, "completed", { CallDuration: "30" });
    expect(await calls()).toMatchObject([{ status: "no-answer", outcome: "voicemail" }]);
    expect((await owner.get<{ items: unknown[] }>("/api/calls?filter=missed")).items).toEqual([]);
  });

  it("keeps the call forwarded when the leg was answered before the dial ended unsuccessfully", async () => {
    await setup();
    await inbound();
    await press("3");
    for (const st of ["initiated", "ringing", "in-progress"])
      await status(CHILD, st, { ParentCallSid: PARENT });
    expect((await calls())[0]!.answered_at).not.toBeNull();
    await forwardDone("failed");
    expect(await calls()).toMatchObject([{ outcome: "forwarded" }]);
  });

  it("spends one call from the hourly budget per forward, even when Twilio retries the key", async () => {
    // Saving the menu spends nothing, so a budget of one covers exactly this one forward.
    await setup(MENU, { callsPerHour: 1 });
    await inbound();
    expect(await press("3")).toBe(FORWARD(US_2));
    expect(await press("3")).toBe(FORWARD(US_2));
    expect(await calls()).toMatchObject([{ outcome: "forwarded" }]);
  });

  it("replays the stored number when Twilio retries the key after the menu changed", async () => {
    const { owner, numberId } = await setup();
    await inbound();
    expect(await press("3")).toBe(FORWARD(US_2));
    expect(await calls()).toMatchObject([{ outcome: "forwarded", forwarded_to: US_2 }]);
    // The owner repoints key 3 at another number, then the retry arrives.
    await owner.json("PUT", `/api/menus/numbers/${numberId}`, {
      ...MENU,
      keys: [{ digit: "3", action: "forward", to: US }],
    });
    expect(await press("3")).toBe(FORWARD(US_2));
    await owner.json("PUT", `/api/menus/numbers/${numberId}`, { ...MENU, enabled: false });
    expect(await press("3")).toBe(FORWARD(US_2));
    expect(await calls()).toMatchObject([{ outcome: "forwarded", forwarded_to: US_2 }]);
  });

  it("refuses a forward the allowlist no longer allows, says so and falls back to voicemail", async () => {
    const { owner } = await setup();
    await allow(owner.userId, ["GB"]);
    await inbound();
    expect(await press("3")).toBe(VOICEMAIL(DEFAULT_GREETING, FORWARD_REFUSED));
    expect(await calls()).toMatchObject([{ outcome: "voicemail" }]);
  });

  it("refuses a forward once the hourly call limit is used up by an earlier call", async () => {
    const other = "CA00000000000000000000000000000003";
    await setup(MENU, { callsPerHour: 1 });
    await inbound();
    expect(await press("3")).toBe(FORWARD(US_2));
    await inbound(other);
    expect(await press("3", 1, other)).toBe(VOICEMAIL(DEFAULT_GREETING, FORWARD_REFUSED));
    expect(await calls()).toMatchObject([{ outcome: "forwarded" }, { outcome: "voicemail" }]);
  });

  it("saves a menu with forward keys even when the hourly call budget is used up", async () => {
    const { owner, numberId } = await setup(MENU, { callsPerHour: 1 });
    await inbound();
    expect(await press("3")).toBe(FORWARD(US_2));
    const next: NumberMenuInput = {
      ...MENU,
      keys: [...MENU.keys, { digit: "4", action: "forward", to: US }],
    };
    expect(await owner.json("PUT", `/api/menus/numbers/${numberId}`, next)).toEqual({ numberId, ...next });
  });
});

describe("phone menu: no key or a wrong key", () => {
  it("repeats the prompt once on a timeout, then takes the default action (voicemail)", async () => {
    await setup();
    await inbound();
    expect(await press("", 1)).toBe(GATHER(MENU.prompt, 2));
    expect(await press("", 2)).toBe(VOICEMAIL(DEFAULT_GREETING));
    expect(await calls()).toMatchObject([{ outcome: "voicemail" }]);
  });

  it("repeats the prompt once on a key with nothing behind it, then rings when that is the default", async () => {
    await setup({ ...MENU, defaultAction: "ring" });
    await inbound();
    expect(await press("9", 1)).toBe(GATHER(MENU.prompt, 2));
    const xml = await press("7", 2);
    expect(xml).toContain("<Enqueue");
    expect((await calls())[0]!.queue_name).toMatch(/^tq_/);
  });

  it("still takes a valid key on the second attempt", async () => {
    await setup();
    await inbound();
    await press("", 1);
    expect(await press("2", 2)).toBe(VOICEMAIL(DEFAULT_GREETING));
  });

  it("counts a caller who hangs up in the menu as missed", async () => {
    const { owner } = await setup();
    await inbound();
    await status(PARENT, "completed", { CallDuration: "8" });
    expect(await calls()).toMatchObject([{ outcome: "missed", status: "no-answer" }]);
    expect((await owner.get<{ items: unknown[] }>("/api/calls?filter=missed")).items).toHaveLength(1);
  });

  it("rings as usual when the menu is turned off while the caller listens", async () => {
    const { owner, numberId } = await setup();
    await inbound();
    await owner.json("PUT", `/api/menus/numbers/${numberId}`, { ...MENU, enabled: false });
    expect(await press("2")).toContain("<Enqueue");
  });

  it("hangs up on a menu request for a call it does not know", async () => {
    await setup();
    expect(await press("1")).toBe(response("<Hangup/>"));
  });
});

describe("phone menu settings API", () => {
  it("returns an empty menu by default and saves one per number", async () => {
    const { owner, numberId } = await setup(null);
    expect(await owner.get("/api/menus")).toEqual({
      items: [{ numberId, enabled: false, prompt: "", keys: [], defaultAction: "ring" }],
    });
    const saved = await owner.json("PUT", `/api/menus/numbers/${numberId}`, {
      ...MENU,
      prompt: `  ${MENU.prompt}  `,
    });
    expect(saved).toEqual({ numberId, ...MENU });
    expect((await owner.get("/api/menus")).items).toEqual([{ numberId, ...MENU }]);
  });

  it("checks every forward key on each save, including ones saved before", async () => {
    const { owner, numberId } = await setup();
    await allow(owner.userId, ["GB"]);
    const body = (to: string): NumberMenuInput => ({
      ...MENU,
      keys: [{ digit: "3", action: "forward", to }],
    });
    // US_2 was saved earlier, but the allowlist no longer covers it: a save that keeps it is refused too.
    await owner.json("PUT", `/api/menus/numbers/${numberId}`, body(US_2), 403);
    await owner.json("PUT", `/api/menus/numbers/${numberId}`, body("+442071838750"), 200);
  });

  it("refuses bad menus", async () => {
    const { owner, numberId } = await setup(null);
    const put = (body: unknown, code: number) =>
      owner.json("PUT", `/api/menus/numbers/${numberId}`, body, code);
    await put({ ...MENU, keys: [] }, 400);
    await put({ ...MENU, prompt: " " }, 400);
    await put({ ...MENU, prompt: "x".repeat(501) }, 400);
    await put(
      {
        ...MENU,
        keys: [
          { digit: "1", action: "ring" },
          { digit: "1", action: "voicemail" },
        ],
      },
      400,
    );
    await put({ ...MENU, keys: [{ digit: "0", action: "ring" }] }, 400);
    await put({ ...MENU, keys: [{ digit: "1", action: "forward", to: "4155552672" }] }, 400);
    await put({ ...MENU, keys: [{ digit: "1", action: "ring", to: US }] }, 400);
    await put({ ...MENU, defaultAction: "forward" }, 400);
    // A menu that is off may be saved half done.
    await put({ ...MENU, enabled: false, keys: [] }, 200);
  });

  it("checks every new forward number with the call allowlist and premium block", async () => {
    const { owner, numberId } = await setup(null);
    const put = (to: string, code: number) =>
      owner.json(
        "PUT",
        `/api/menus/numbers/${numberId}`,
        { ...MENU, keys: [{ digit: "1", action: "forward", to }] },
        code,
      );
    expect((await put(UK, 403)).error).toBe("country_not_allowed");
    expect((await put("+19005550123", 403)).error).toBe("premium_rate");
    expect((await owner.get("/api/menus")).items[0].enabled).toBe(false);
    await put(US_2, 200);
  });

  it("only touches the owner's own numbers", async () => {
    const { owner } = await setup(null);
    await owner.json("PUT", `/api/menus/numbers/${crypto.randomUUID()}`, MENU, 404);
    const other = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Other', 'other@talvuno.test', 0, ?, ?)",
    )
      .bind(other, Date.now(), Date.now())
      .run();
    const theirs = await addNumber(other, "+14155550199");
    await owner.json("PUT", `/api/menus/numbers/${theirs}`, MENU, 404);
    expect((await owner.get<{ items: unknown[] }>("/api/menus")).items).toHaveLength(1);
  });

  it("shows the TwiML of a wording without saving anything", async () => {
    const { owner } = await setup(null);
    const { twiml } = await owner.post<{ twiml: string }>("/api/menus/preview", {
      prompt: "Press 1 & wait <here>",
    });
    expect(twiml).toBe(GATHER("Press 1 &amp; wait &lt;here&gt;", 1));
    expect((await owner.get("/api/menus")).items[0].enabled).toBe(false);
  });
});
