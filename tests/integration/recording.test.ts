import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cronJobs } from "../../src/worker/cron";
import { SUMMARY_MODEL } from "../../src/worker/lib/ai/summary-prompt";
import {
  streamToBase64,
  TOO_LONG_TO_TRANSCRIBE,
  TRANSCRIBE_MAX_BYTES,
} from "../../src/worker/lib/recordings/store";
import { voiceIdentity } from "../../src/worker/lib/voice/identity";
import {
  callRecordingKey,
  DEFAULT_RECORDING_NOTICE,
  pruneCallRecordings,
  repairCallRecordings,
} from "../../src/worker/lib/voice/recording";
import { handleTranscribeBatch, TRANSCRIBE_MODEL } from "../../src/worker/lib/voicemail";
import { createOwner, resetDb, type Session } from "./helpers";
import { signedTwilioPost } from "./twilio-helpers";

const OURS = "+14155550100";
const US = "+14155552671";
const PARENT = "CA00000000000000000000000000000001";
const ANSWER = "CA00000000000000000000000000000009";
const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
const TWILIO = "https://twilio.mock/2010-04-01/Accounts/AC00000000000000000000000000000000";
const CALLBACK = "https://talvuno.test/api/twilio/voice/recording";
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
const sid = (prefix: string) => `${prefix}${String(++seq).padStart(32, "0")}`;

type Original = { TRANSCRIBE: Queue; AI: Ai };
const original: Original = { TRANSCRIBE: env.TRANSCRIBE, AI: env.AI };
let sent: unknown[] = [];

beforeEach(async () => {
  await resetDb();
  sent = [];
  (env as { TRANSCRIBE: unknown }).TRANSCRIBE = { send: async (m: unknown) => void sent.push(m) };
});
afterEach(() => {
  vi.restoreAllMocks();
  (env as Original).TRANSCRIBE = original.TRANSCRIBE;
  (env as Original).AI = original.AI;
});

type Seen = { method: string; url: string; body: string };

/** Mocks Twilio's REST API: recording downloads and deletes, and a call's recordings list. */
function mockTwilio(opts: { live?: { sid: string; status: string }[]; liveOn?: string } = {}) {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const body = req.method === "POST" ? await req.text() : "";
    seen.push({ method: req.method, url: req.url, body });
    const path = req.url.slice(TWILIO.length);
    if (path.startsWith("/Recordings/")) {
      if (req.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(AUDIO, { headers: { "content-type": "audio/mpeg" } });
    }
    const list = path.match(/^\/Calls\/(CA\w+)\/Recordings\.json$/);
    if (list && req.method === "GET") {
      const recordings = !opts.liveOn || opts.liveOn === list[1] ? (opts.live ?? []) : [];
      return Response.json({ recordings });
    }
    if (list && req.method === "POST")
      return Response.json({ sid: sid("RE"), status: "in-progress" }, { status: 201 });
    const one = path.match(/^\/Calls\/CA\w+\/Recordings\/(RE\w+)\.json$/);
    if (one) {
      const status = new URLSearchParams(body).get("Status");
      return Response.json({ sid: one[1], status });
    }
    return new Response("not mocked", { status: 599 });
  });
  return seen;
}

async function addNumber(ownerId: string, e164 = OURS) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO phone_numbers (id, owner_id, e164, twilio_sid, friendly_name, capabilities, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, 1, ?, ?)",
  )
    .bind(
      id,
      ownerId,
      e164,
      sid("PN"),
      JSON.stringify({ voice: true, sms: true, mms: false }),
      Date.now(),
      Date.now(),
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO user_preferences (user_id, country_allowlist, calls_per_hour, updated_at) VALUES (?, ?, 20, ?) ON CONFLICT(user_id) DO UPDATE SET country_allowlist = excluded.country_allowlist",
  )
    .bind(ownerId, JSON.stringify(["US"]), Date.now())
    .run();
  return id;
}

async function setup() {
  const owner = await createOwner();
  const numberId = await addNumber(owner.userId);
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
const inbound = async () =>
  (await signedTwilioPost("/api/twilio/voice/inbound", { CallSid: PARENT, From: US, To: OURS })).text();

const calls = async () =>
  (await env.DB.prepare("SELECT * FROM calls ORDER BY created_at").all<{ id: string; queue_name: string }>())
    .results;

type RecRaw = {
  id: string;
  owner_id: string;
  call_id: string;
  r2_key: string | null;
  twilio_deleted_at: number | null;
  duration: number | null;
  channels: number;
  transcript: string | null;
  transcript_status: string;
  created_at: number;
};
const recordings = async () =>
  (await env.DB.prepare("SELECT * FROM call_recordings ORDER BY created_at").all<RecRaw>()).results;

async function until<T>(read: () => Promise<T>, check: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!check(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 25));
    v = await read();
  }
  return v;
}

const callback = (callSid: string, recordingSid: string, extra: Record<string, string> = {}) =>
  signedTwilioPost("/api/twilio/voice/recording", {
    AccountSid: "AC00000000000000000000000000000000",
    CallSid: callSid,
    RecordingSid: recordingSid,
    RecordingStatus: "completed",
    RecordingDuration: "75",
    RecordingChannels: "2",
    RecordingSource: "DialVerb",
    ...extra,
  });

const record = (
  owner: Awaited<ReturnType<typeof createOwner>>,
  numberId: string,
  on: boolean,
  notice: boolean,
  noticeText: string | null = null,
) =>
  owner.json("PUT", `/api/recordings/settings/${numberId}`, {
    recordCalls: on,
    playNotice: notice,
    noticeText,
  });

/** An outbound call through the real webhook, recorded and stored through the real callback. */
async function storedRecording(_owner: Awaited<ReturnType<typeof createOwner>>, from: string) {
  await outbound(from, US);
  const recSid = sid("RE");
  expect((await callback(PARENT, recSid)).status).toBe(204);
  const [row] = await until(recordings, (r) => Boolean(r[0]?.r2_key));
  return { row: row!, recSid };
}

describe("recording settings", () => {
  it("are off by default, save per number and refuse a foreign number", async () => {
    const { owner, numberId } = await setup();
    expect(await owner.get("/api/recordings/settings")).toEqual({
      items: [{ numberId, recordCalls: false, playNotice: false, noticeText: null }],
    });
    await record(owner, numberId, true, true, "  ");
    expect((await owner.get("/api/recordings/settings")).items[0]).toEqual({
      numberId,
      recordCalls: true,
      playNotice: true,
      noticeText: null,
    });
    await owner.json(
      "PUT",
      `/api/recordings/settings/${crypto.randomUUID()}`,
      { recordCalls: true, playNotice: false, noticeText: null },
      404,
    );
    await owner.json("PUT", `/api/recordings/settings/${numberId}`, { recordCalls: true }, 400);
  });
});

describe("TwiML", () => {
  it("adds nothing to the outbound dial while recording is off", async () => {
    const { from } = await setup();
    const xml = await (await outbound(from, US)).text();
    expect(xml).not.toContain("record");
    expect(xml).not.toContain(" url=");
  });

  it("records an outbound call on both channels from answer, without a notice unless it is on", async () => {
    const { owner, numberId, from } = await setup();
    await record(owner, numberId, true, false);
    const xml = await (await outbound(from, US)).text();
    expect(xml).toContain(
      `record="record-from-answer-dual" recordingStatusCallback="${CALLBACK}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"`,
    );
    expect(xml).not.toContain(" url=");
  });

  it("plays the notice to the called party through the whisper before the bridge", async () => {
    const { owner, numberId, from } = await setup();
    await record(owner, numberId, true, true, "This call is recorded for training.");
    const xml = await (await outbound(from, US)).text();
    expect(xml).toContain(`<Number url="${CALLBACK}/notice" method="POST" statusCallback=`);
    const whisper = await signedTwilioPost("/api/twilio/voice/recording/notice", {
      CallSid: sid("CA"),
      ParentCallSid: PARENT,
    });
    expect(await whisper.text()).toContain("<Say>This call is recorded for training.</Say>");
  });

  it("says nothing in the whisper when the notice is off, and connects a call it does not know", async () => {
    const { owner, numberId, from } = await setup();
    await record(owner, numberId, true, false);
    await outbound(from, US);
    const quiet = await signedTwilioPost("/api/twilio/voice/recording/notice", {
      CallSid: sid("CA"),
      ParentCallSid: PARENT,
    });
    expect(await quiet.text()).not.toContain("<Say>");
    const unknown = await signedTwilioPost("/api/twilio/voice/recording/notice", {
      CallSid: sid("CA"),
      ParentCallSid: sid("CA"),
    });
    expect(await unknown.text()).not.toContain("<Say>");
  });

  it("plays the inbound notice before the queue and records the answering dial", async () => {
    const { owner, numberId, from } = await setup();
    await record(owner, numberId, true, true);
    const xml = await inbound();
    expect(xml).toMatch(
      new RegExp(`<Response><Say>${DEFAULT_RECORDING_NOTICE.replace(/\./g, "\\.")}</Say><Enqueue `),
    );
    const [row] = await calls();
    const answer = await (await outbound(from, "", { AnswerCallId: row!.id }, ANSWER)).text();
    expect(answer).toContain(
      `<Dial timeLimit="7200" action="https://talvuno.test/api/twilio/voice/hold/owner" method="POST" record="record-from-answer-dual" recordingStatusCallback="${CALLBACK}"`,
    );
  });

  it("leaves inbound TwiML as it was while recording is off, and plays no notice while only recording is on", async () => {
    const { owner, numberId, from } = await setup();
    let xml = await inbound();
    expect(xml).toMatch(/^<\?xml[^>]*><Response><Enqueue /);
    const [row] = await calls();
    const answer = await (await outbound(from, "", { AnswerCallId: row!.id }, ANSWER)).text();
    expect(answer).not.toContain("record");
    await record(owner, numberId, true, false);
    xml = await inbound();
    expect(xml).not.toContain("<Say>");
  });

  it("plays the notice on every path while it is on, even when calls are not recorded from the start", async () => {
    const { owner, numberId, from } = await setup();
    await record(owner, numberId, false, true, "Calls on this line may be recorded.");
    const out = await (await outbound(from, US)).text();
    expect(out).not.toContain("record=");
    expect(out).toContain(`<Number url="${CALLBACK}/notice" method="POST" statusCallback=`);
    const whisper = await signedTwilioPost("/api/twilio/voice/recording/notice", {
      CallSid: sid("CA"),
      ParentCallSid: PARENT,
    });
    expect(await whisper.text()).toContain("<Say>Calls on this line may be recorded.</Say>");

    await resetDb();
    const again = await setup();
    await record(again.owner, again.numberId, false, true);
    const xml = await inbound();
    expect(xml).toMatch(
      new RegExp(`<Response><Say>${DEFAULT_RECORDING_NOTICE.replace(/\./g, "\\.")}</Say><Enqueue `),
    );
    const [row] = await calls();
    const answer = await (await outbound(again.from, "", { AnswerCallId: row!.id }, ANSWER)).text();
    expect(answer).not.toContain("record=");
  });
});

describe("recording status callback", () => {
  it("is refused without Twilio's signature", async () => {
    await setup();
    const res = await signedTwilioPost(
      "/api/twilio/voice/recording",
      { CallSid: PARENT, RecordingSid: sid("RE"), RecordingStatus: "completed" },
      { signature: "bad" },
    );
    expect(res.status).toBe(403);
  });

  it("stores the dual-channel audio in R2, deletes the Twilio copy and queues the transcript", async () => {
    const seen = mockTwilio();
    const { owner, from } = await setup();
    const { row, recSid } = await storedRecording(owner, from);
    const [call] = await calls();
    expect(row).toMatchObject({ owner_id: owner.userId, call_id: call!.id, duration: 75, channels: 2 });
    expect(row.r2_key).toBe(callRecordingKey(owner.userId, call!.id, recSid));
    expect(row.r2_key).toBe(`recording/${owner.userId}/${call!.id}/${recSid}.mp3`);
    const object = await env.RECORDINGS.get(row.r2_key!);
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(AUDIO);
    const done = await until(recordings, (r) => Boolean(r[0]?.twilio_deleted_at));
    expect(done[0]!.twilio_deleted_at).not.toBeNull();
    expect(seen.map((s) => `${s.method} ${s.url.slice(TWILIO.length)}`)).toEqual([
      `GET /Recordings/${recSid}.mp3?RequestedChannels=2`,
      `DELETE /Recordings/${recSid}.json`,
    ]);
    expect(sent).toEqual([{ kind: "call", id: row.id }]);
  });

  it("processes a retried callback once", async () => {
    const seen = mockTwilio();
    const { owner, from } = await setup();
    const { recSid } = await storedRecording(owner, from);
    expect((await callback(PARENT, recSid)).status).toBe(204);
    await new Promise((r) => setTimeout(r, 100));
    expect(await recordings()).toHaveLength(1);
    expect(seen.filter((s) => s.method === "GET")).toHaveLength(1);
  });

  it("finds an inbound call by the caller's leg or by the answering leg", async () => {
    mockTwilio();
    const { from } = await setup();
    await inbound();
    const [row] = await calls();
    await outbound(from, "", { AnswerCallId: row!.id }, ANSWER);
    expect((await callback(PARENT, sid("RE"))).status).toBe(204);
    expect((await callback(ANSWER, sid("RE"), { RecordingSource: "StartCallRecordingAPI" })).status).toBe(
      204,
    );
    const stored = await until(recordings, (r) => r.length === 2 && r.every((x) => x.r2_key));
    expect(stored.map((r) => r.call_id)).toEqual([row!.id, row!.id]);
  });

  it("asks Twilio to retry a recording of a call it does not know, and ignores other statuses", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await setup();
    expect((await callback(sid("CA"), sid("RE"))).status).toBe(500);
    expect((await callback(PARENT, sid("RE"), { RecordingStatus: "absent" })).status).toBe(204);
    expect(await recordings()).toHaveLength(0);
  });

  it("keeps the Twilio copy when the download fails, and the cron finishes it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { owner, from } = await setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("down", { status: 503 }));
    await outbound(from, US);
    await callback(PARENT, sid("RE"));
    const [failed] = await until(recordings, (r) => r.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(failed!.r2_key).toBeNull();
    vi.restoreAllMocks();
    mockTwilio();
    expect(cronJobs).toContain(repairCallRecordings);
    expect(cronJobs).toContain(pruneCallRecordings);
    await repairCallRecordings(env, undefined, Date.now() + 10 * 60 * 1000);
    const [after] = await recordings();
    expect(after!.r2_key).toBeTruthy();
    expect(after!.twilio_deleted_at).not.toBeNull();
    expect(owner.userId).toBe(after!.owner_id);
  });
});

function fakeBatch(messages: { body: unknown; attempts: number }[]) {
  const acked: number[] = [];
  const batch = {
    queue: "talvuno-transcribe",
    messages: messages.map((m, index) => ({
      id: String(index),
      timestamp: new Date(),
      body: m.body,
      attempts: m.attempts,
      ack: () => void acked.push(index),
      retry: () => {},
    })),
  } as unknown as MessageBatch<unknown>;
  return { batch, acked };
}

describe("transcription", () => {
  it("encodes streamed audio to the same base64 whatever the chunk sizes", async () => {
    const bytes = new Uint8Array(70_001).map((_, i) => (i * 31) % 256);
    let expected = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      expected += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    expected = btoa(expected);
    for (const sizes of [[70_001], [1, 2, 4, 30_000, 39_994], [5, 5, 69_991]]) {
      let at = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const size = sizes.shift();
          if (size === undefined) return controller.close();
          controller.enqueue(bytes.slice(at, at + size));
          at += size;
        },
      });
      expect(await streamToBase64(stream)).toBe(expected);
    }
  });

  it("transcribes a call recording from its queue message", async () => {
    mockTwilio();
    const { owner, from } = await setup();
    const { row } = await storedRecording(owner, from);
    const run = vi.fn(async () => ({ text: " Hello, thanks for calling. " }));
    (env as { AI: unknown }).AI = { run };
    const { batch, acked } = fakeBatch([{ body: { kind: "call", id: row.id }, attempts: 1 }]);
    await handleTranscribeBatch(batch, env);
    expect(acked).toEqual([0]);
    expect(run).toHaveBeenCalledTimes(1);
    expect((await recordings())[0]).toMatchObject({
      transcript: "Hello, thanks for calling.",
      transcript_status: "done",
    });
  });

  it("fails audio over the Whisper cap at once without calling Whisper, and the cron leaves it failed", async () => {
    mockTwilio();
    const { owner, from } = await setup();
    const { row } = await storedRecording(owner, from);
    await env.RECORDINGS.put(row.r2_key!, new Uint8Array(TRANSCRIBE_MAX_BYTES + 1));
    sent = [];
    const run = vi.fn(async () => ({ text: "never" }));
    (env as { AI: unknown }).AI = { run };
    const { batch, acked } = fakeBatch([{ body: { kind: "call", id: row.id }, attempts: 1 }]);
    await handleTranscribeBatch(batch, env);
    expect(acked).toEqual([0]);
    expect(run).not.toHaveBeenCalled();
    expect((await recordings())[0]).toMatchObject({
      transcript: null,
      transcript_status: "failed",
      transcript_error: TOO_LONG_TO_TRANSCRIBE,
    });
    // Old enough for the stale-transcript repair, young enough to still be inside its window.
    await env.DB.prepare("UPDATE call_recordings SET created_at = ? WHERE id = ?")
      .bind(Date.now() - 3 * 60 * 60 * 1000, row.id)
      .run();
    await repairCallRecordings(env);
    expect(sent).toEqual([]);
    expect((await recordings())[0]!.transcript_status).toBe("failed");
  });
});

describe("recordings API", () => {
  it("lists a call's recordings, streams the audio with Range and deletes it, for the owner only", async () => {
    const seen = mockTwilio();
    const { owner, from } = await setup();
    const { row } = await storedRecording(owner, from);
    const [call] = await calls();

    const list = await owner.get(`/api/calls/${call!.id}/recordings`);
    expect(list.items).toMatchObject([
      {
        id: row.id,
        callId: call!.id,
        duration: 75,
        channels: 2,
        audioReady: true,
        transcriptStatus: "pending",
      },
    ]);
    const recents = await owner.get("/api/calls");
    expect(recents.items[0]).toMatchObject({ id: call!.id, recorded: true });

    const part = await owner.fetch(`/api/recordings/${row.id}/audio`, { headers: { range: "bytes=0-3" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("cache-control")).toBe("private, no-store");
    expect(part.headers.get("content-range")).toBe(`bytes 0-3/${AUDIO.length}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(AUDIO.slice(0, 4));

    // Another owner, or no session, sees nothing.
    const other = crypto.randomUUID();
    await env.DB.prepare("UPDATE call_recordings SET owner_id = ? WHERE id = ?")
      .bind(owner.userId, row.id)
      .run();
    const { Session } = await import("./helpers");
    const anon = new Session();
    expect((await anon.fetch(`/api/recordings/${row.id}/audio`)).status).toBe(401);
    await env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Other', ?, 0, ?, ?)",
    )
      .bind(other, `${other}@other.test`, Date.now(), Date.now())
      .run();
    await env.DB.prepare("UPDATE call_recordings SET owner_id = ? WHERE id = ?").bind(other, row.id).run();
    expect((await owner.fetch(`/api/recordings/${row.id}/audio`)).status).toBe(404);
    expect((await owner.fetch(`/api/recordings/${row.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await owner.get(`/api/calls/${call!.id}/recordings`)).items).toEqual([]);
    await env.DB.prepare("UPDATE call_recordings SET owner_id = ? WHERE id = ?")
      .bind(owner.userId, row.id)
      .run();

    expect((await owner.fetch(`/api/recordings/${row.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await recordings()).toHaveLength(0);
    expect(await env.RECORDINGS.get(row.r2_key!)).toBeNull();
    expect(seen.filter((s) => s.method === "DELETE")).toHaveLength(1);
  });

  it("prunes call recordings with the voicemail retention", async () => {
    mockTwilio();
    const { owner, from } = await setup();
    const { row } = await storedRecording(owner, from);
    await owner.json("PUT", "/api/voicemails/settings", { retentionDays: 7 });
    await pruneCallRecordings(env, undefined, Date.now() + 6 * DAY);
    expect(await recordings()).toHaveLength(1);
    await pruneCallRecordings(env, undefined, Date.now() + 8 * DAY);
    expect(await recordings()).toHaveLength(0);
    expect(await env.RECORDINGS.get(row.r2_key!)).toBeNull();
  });
});

describe("live recording switch", () => {
  it("starts a dual-channel recording on the owner's leg, then pauses and resumes it", async () => {
    const { owner, from } = await setup();
    await outbound(from, US);
    let seen = mockTwilio();
    expect(await owner.get(`/api/recordings/live?callSid=${PARENT}`)).toEqual({ state: "off" });
    expect(await owner.post("/api/recordings/live", { callSid: PARENT, action: "start" })).toEqual({
      state: "recording",
    });
    const start = seen.find((s) => s.method === "POST")!;
    expect(start.url).toBe(`${TWILIO}/Calls/${PARENT}/Recordings.json`);
    const form = new URLSearchParams(start.body);
    expect(form.get("RecordingChannels")).toBe("dual");
    expect(form.get("RecordingStatusCallback")).toBe(CALLBACK);
    expect(form.get("RecordingStatusCallbackEvent")).toBe("completed");

    vi.restoreAllMocks();
    const running = sid("RE");
    seen = mockTwilio({ live: [{ sid: running, status: "in-progress" }] });
    // A second start never makes a second recording.
    expect(await owner.post("/api/recordings/live", { callSid: PARENT, action: "start" })).toEqual({
      state: "recording",
    });
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(0);
    expect(await owner.post("/api/recordings/live", { callSid: PARENT, action: "pause" })).toEqual({
      state: "paused",
    });
    const pause = seen.find((s) => s.method === "POST")!;
    expect(pause.url).toBe(`${TWILIO}/Calls/${PARENT}/Recordings/${running}.json`);
    expect(new URLSearchParams(pause.body).get("Status")).toBe("paused");

    vi.restoreAllMocks();
    seen = mockTwilio({ live: [{ sid: running, status: "paused" }] });
    expect(await owner.post("/api/recordings/live", { callSid: PARENT, action: "resume" })).toEqual({
      state: "recording",
    });
    expect(new URLSearchParams(seen.find((s) => s.method === "POST")!.body).get("Status")).toBe(
      "in-progress",
    );
  });

  it("pauses an inbound call's dial recording, which runs on the caller's leg", async () => {
    const { owner, from } = await setup();
    await inbound();
    const [row] = await calls();
    await outbound(from, "", { AnswerCallId: row!.id }, ANSWER);
    const running = sid("RE");
    const seen = mockTwilio({ live: [{ sid: running, status: "in-progress" }], liveOn: PARENT });
    expect(await owner.post("/api/recordings/live", { callSid: ANSWER, action: "pause" })).toEqual({
      state: "paused",
    });
    expect(seen.find((s) => s.method === "POST")!.url).toBe(
      `${TWILIO}/Calls/${PARENT}/Recordings/${running}.json`,
    );
  });

  it("refuses a new recording mid-call while the notice is on, and allows it when the notice is off", async () => {
    const { owner, numberId, from } = await setup();
    await record(owner, numberId, false, true);
    await outbound(from, US);
    let seen = mockTwilio();
    const refused = await owner.json(
      "POST",
      "/api/recordings/live",
      { callSid: PARENT, action: "start" },
      409,
    );
    expect(refused).toMatchObject({ error: "recording_notice_on" });
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(0);

    vi.restoreAllMocks();
    await record(owner, numberId, false, false);
    seen = mockTwilio();
    expect(await owner.post("/api/recordings/live", { callSid: PARENT, action: "start" })).toEqual({
      state: "recording",
    });
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(1);
  });

  it("still pauses an announced recording while the notice is on", async () => {
    const { owner, numberId, from } = await setup();
    await record(owner, numberId, true, true);
    await outbound(from, US);
    const running = sid("RE");
    mockTwilio({ live: [{ sid: running, status: "in-progress" }] });
    expect(await owner.post("/api/recordings/live", { callSid: PARENT, action: "pause" })).toEqual({
      state: "paused",
    });
  });

  it("is owner-only and scoped to a live call", async () => {
    const { owner, from } = await setup();
    const seen = mockTwilio();
    // No such call, a malformed SID, the caller's leg of an inbound call, an ended call.
    await owner.json("POST", "/api/recordings/live", { callSid: sid("CA"), action: "start" }, 404);
    await owner.json("POST", "/api/recordings/live", { callSid: "nope", action: "start" }, 400);
    await inbound();
    await owner.json("POST", "/api/recordings/live", { callSid: PARENT, action: "start" }, 404);
    await resetDb();
    const again = await setup();
    await outbound(again.from, US);
    await env.DB.prepare("UPDATE calls SET ended_at = ? WHERE twilio_call_sid = ?")
      .bind(Date.now(), PARENT)
      .run();
    await again.owner.json("POST", "/api/recordings/live", { callSid: PARENT, action: "start" }, 404);
    const { Session } = await import("./helpers");
    expect(
      (
        await new Session().fetch("/api/recordings/live", {
          method: "POST",
          json: { callSid: PARENT, action: "start" },
        })
      ).status,
    ).toBe(401);
    expect(seen.filter((s) => s.url.startsWith(TWILIO))).toHaveLength(0);
    expect(from).toBeTruthy();
  });
});

describe("call recording summaries", () => {
  const TRANSCRIPT = "Hi, it's Sam from Acme. Please call me back on 0400 111 222 about the quote.";
  const REPLY = {
    summary: "Sam from Acme asked for a call back about the quote.",
    actionItems: ["Call Sam back on 0400 111 222"],
  };

  function mockAi() {
    const run = vi.fn(async (model: string) => {
      if (model === TRANSCRIBE_MODEL) return { text: TRANSCRIPT };
      return { choices: [{ message: { role: "assistant", content: JSON.stringify(REPLY) } }] };
    });
    (env as { AI: unknown }).AI = { run };
    return run;
  }
  const summaryCalls = (run: ReturnType<typeof mockAi>) =>
    run.mock.calls.filter(([m]) => m === SUMMARY_MODEL);
  type SummaryRaw = { source_kind: string; source_id: string; status: string; summary: string | null };
  const summaryRows = async () =>
    (await env.DB.prepare("SELECT * FROM ai_summaries").all<SummaryRaw>()).results;

  /** Opens the live socket of `s` and collects the frames it receives. */
  async function openLive(s: Session) {
    const res = await s.fetch("/api/live", { headers: { upgrade: "websocket" } });
    const ws = res.webSocket!;
    const frames: { type: string; recordingId?: string; callId?: string }[] = [];
    ws.addEventListener("message", (e) => {
      try {
        frames.push(JSON.parse(String(e.data)));
      } catch {}
    });
    ws.accept();
    return { ws, frames };
  }

  /** Transcribes the recording through the queue consumer, then delivers the summary job that queued. */
  async function transcribeAndSummarise(id: string) {
    await handleTranscribeBatch(fakeBatch([{ body: { kind: "call", id }, attempts: 1 }]).batch, env);
    const jobs = sent.splice(0).filter((m) => (m as { type?: string }).type === "summary");
    await handleTranscribeBatch(fakeBatch(jobs.map((body) => ({ body, attempts: 1 }))).batch, env);
    return jobs;
  }

  it("summarises a transcribed call recording through the queue, tells the screens and shows it in the API", async () => {
    mockTwilio();
    const { owner, from } = await setup();
    const { row } = await storedRecording(owner, from);
    sent.length = 0;
    const run = mockAi();
    const live = await openLive(owner);

    const jobs = await transcribeAndSummarise(row.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: "summary", transcript: TRANSCRIPT });
    expect(summaryCalls(run)).toHaveLength(1);
    expect(await summaryRows()).toMatchObject([{ source_kind: "call", source_id: row.id, status: "done" }]);
    await until(
      async () => live.frames,
      (f) => f.filter((x) => x.type === "recording").length >= 2,
    );
    live.ws.close();
    expect(live.frames.filter((f) => f.type === "recording" && f.recordingId === row.id).length).toBe(2);

    const [call] = await calls();
    const list = await owner.get(`/api/calls/${call!.id}/recordings`);
    expect(list.items[0].aiSummary).toEqual({
      summary: REPLY.summary,
      actionItems: REPLY.actionItems,
      oneLiner: null,
    });

    await owner.json("PUT", "/api/ai-summaries/settings", { enabled: false });
    expect((await owner.get(`/api/calls/${call!.id}/recordings`)).items[0].aiSummary).toBeNull();
  });

  it("makes no summary and no model call while summaries are off, and the recording shows none", async () => {
    mockTwilio();
    const { owner, from } = await setup();
    await owner.json("PUT", "/api/ai-summaries/settings", { enabled: false });
    const { row } = await storedRecording(owner, from);
    sent.length = 0;
    const run = mockAi();

    const jobs = await transcribeAndSummarise(row.id);
    expect(jobs).toEqual([]);
    expect(summaryCalls(run)).toHaveLength(0);
    expect(await summaryRows()).toEqual([]);
    const [call] = await calls();
    const item = (await owner.get(`/api/calls/${call!.id}/recordings`)).items[0];
    expect(item.transcriptStatus).toBe("done");
    expect(item.aiSummary).toBeNull();
  });

  it("deletes the summary row with the recording, and when retention prunes it", async () => {
    mockTwilio();
    const { owner, from } = await setup();
    const { row } = await storedRecording(owner, from);
    sent.length = 0;
    mockAi();
    await transcribeAndSummarise(row.id);
    expect(await summaryRows()).toHaveLength(1);
    expect((await owner.fetch(`/api/recordings/${row.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await recordings()).toHaveLength(0);
    expect(await summaryRows()).toEqual([]);

    // A second recording, this time removed by retention pruning.
    await env.DB.prepare("DELETE FROM calls").run();
    const second = await storedRecording(owner, from);
    sent.length = 0;
    await transcribeAndSummarise(second.row.id);
    expect(await summaryRows()).toHaveLength(1);
    await owner.json("PUT", "/api/voicemails/settings", { retentionDays: 7 });
    await pruneCallRecordings(env, undefined, Date.now() + 8 * DAY);
    expect(await recordings()).toHaveLength(0);
    expect(await summaryRows()).toEqual([]);
  });
});
