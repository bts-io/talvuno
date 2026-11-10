import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cronJobs } from "../../src/worker/cron";
import {
  handleTranscribeBatch,
  pruneVoicemails,
  repairVoicemails,
  STORE_RETRY_AFTER_MS,
  TRANSCRIBE_MAX_RETRIES,
  TRANSCRIBE_MODEL,
  voicemailKey,
} from "../../src/worker/lib/voicemail";
import { parseRange } from "../../src/worker/routes/voicemails";
import { createOwner, resetDb, Session } from "./helpers";
import { signedTwilioPost } from "./twilio-helpers";

const OURS = "+14155550100";
const CALLER = "+14155552671";
const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const TWILIO = "https://twilio.mock/2010-04-01/Accounts/AC00000000000000000000000000000000";
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
const sid = (prefix: string) => `${prefix}${String(++seq).padStart(32, "0")}`;

type Original = { TRANSCRIBE: Queue; AI: Ai };
const original: Original = { TRANSCRIBE: env.TRANSCRIBE, AI: env.AI };
let sent: unknown[] = [];

beforeEach(async () => {
  await resetDb();
  sent = [];
  // The queue is replaced so messages are seen by the test instead of being delivered.
  (env as { TRANSCRIBE: unknown }).TRANSCRIBE = { send: async (m: unknown) => void sent.push(m) };
});
afterEach(() => {
  vi.restoreAllMocks();
  (env as Original).TRANSCRIBE = original.TRANSCRIBE;
  (env as Original).AI = original.AI;
});

type TwilioCall = { method: string; url: string; auth: string | null };

/** Mocks Twilio's REST API. `media` decides the recording download answer. */
function mockTwilio(
  media: () => Response = () => new Response(AUDIO, { headers: { "content-type": "audio/mpeg" } }),
) {
  const seen: TwilioCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    seen.push({ method: req.method, url: req.url, auth: req.headers.get("authorization") });
    if (req.url.startsWith(`${TWILIO}/Recordings/`)) {
      if (req.method === "DELETE") return new Response(null, { status: 204 });
      return media();
    }
    return new Response("not mocked", { status: 599 });
  });
  return seen;
}

async function addNumber(ownerId: string) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO phone_numbers (id, owner_id, e164, twilio_sid, capabilities, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      ownerId,
      `${OURS.slice(0, -2)}${String(seq++ % 100).padStart(2, "0")}`,
      sid("PN"),
      "{}",
      Date.now(),
      Date.now(),
    )
    .run();
  return id;
}

async function addCall(ownerId: string, numberId: string) {
  const id = crypto.randomUUID();
  const callSid = sid("CA");
  await env.DB.prepare(
    "INSERT INTO calls (id, owner_id, twilio_call_sid, direction, number_id, party, status, started_at, created_at, updated_at) VALUES (?, ?, ?, 'inbound', ?, ?, 'no-answer', ?, ?, ?)",
  )
    .bind(id, ownerId, callSid, numberId, CALLER, Date.now(), Date.now(), Date.now())
    .run();
  return { id, callSid };
}

/** A second account, which the owner must never see. Inserted directly: Talvuno has no sign-up. */
async function otherUser() {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Other', ?, 0, ?, ?)",
  )
    .bind(id, `${id}@other.test`, Date.now(), Date.now())
    .run();
  return id;
}

type VoicemailRaw = {
  id: string;
  owner_id: string;
  call_id: string;
  r2_key: string | null;
  content_type: string | null;
  size: number | null;
  store_attempts: number;
  store_error: string | null;
  twilio_deleted_at: number | null;
  transcript: string | null;
  transcript_status: string;
  transcript_error: string | null;
  duration: number | null;
  from: string;
  created_at: number;
  listened_at: number | null;
};
const rows = async () =>
  (await env.DB.prepare("SELECT * FROM voicemails ORDER BY created_at").all<VoicemailRaw>()).results;

/** waitUntil work lands after the response: wait until `check` holds. */
async function until<T>(read: () => Promise<T>, check: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!check(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 25));
    v = await read();
  }
  return v;
}

function callback(callSid: string, recordingSid: string, extra: Record<string, string> = {}) {
  return signedTwilioPost("/api/twilio/voice/voicemail", {
    AccountSid: "AC00000000000000000000000000000000",
    CallSid: callSid,
    RecordingSid: recordingSid,
    RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Recordings/${recordingSid}`,
    RecordingStatus: "completed",
    RecordingDuration: "42",
    RecordingChannels: "1",
    RecordingSource: "RecordVerb",
    ...extra,
  });
}

async function setup() {
  const owner = await createOwner();
  const numberId = await addNumber(owner.userId);
  const call = await addCall(owner.userId, numberId);
  return { owner, numberId, call };
}

/** Records and stores one voicemail for `ownerId` through the real callback. */
async function storedVoicemail(ownerId: string, numberId: string) {
  const call = await addCall(ownerId, numberId);
  const res = await callback(call.callSid, sid("RE"));
  expect(res.status).toBe(204);
  const [row] = await until(
    async () => (await rows()).filter((r) => r.call_id === call.id),
    (r) => Boolean(r[0]?.r2_key),
  );
  return row!;
}

function fakeBatch(messages: { body: unknown; attempts: number }[]) {
  const acked: number[] = [];
  const retried: { index: number; delaySeconds?: number }[] = [];
  const batch = {
    queue: "talvuno-transcribe",
    messages: messages.map((m, index) => ({
      id: String(index),
      timestamp: new Date(),
      body: m.body,
      attempts: m.attempts,
      ack: () => void acked.push(index),
      retry: (o?: { delaySeconds?: number }) => void retried.push({ index, delaySeconds: o?.delaySeconds }),
    })),
    ackAll() {},
    retryAll() {},
  } as unknown as MessageBatch<unknown>;
  return { batch, acked, retried };
}

function mockAi(run: (model: string, input: unknown, options: unknown) => Promise<unknown>) {
  const fn = vi.fn(run);
  (env as { AI: unknown }).AI = { run: fn };
  return fn;
}

describe("recording status callback", () => {
  it("refuses a request without Twilio's signature", async () => {
    const { call } = await setup();
    const res = await signedTwilioPost(
      "/api/twilio/voice/voicemail",
      { CallSid: call.callSid, RecordingSid: sid("RE"), RecordingStatus: "completed" },
      { signature: "bad" },
    );
    expect(res.status).toBe(403);
    expect(await rows()).toHaveLength(0);
  });

  it("stores the audio in R2, deletes the Twilio copy and queues the transcript", async () => {
    const seen = mockTwilio();
    const { owner, numberId, call } = await setup();
    const recordingSid = sid("RE");
    const res = await callback(call.callSid, recordingSid);
    expect(res.status).toBe(204);

    const [row] = await until(rows, (r) => Boolean(r[0]?.twilio_deleted_at));
    const key = voicemailKey(owner.userId, call.id, "mp3");
    expect(row).toMatchObject({
      owner_id: owner.userId,
      call_id: call.id,
      from: CALLER,
      duration: 42,
      r2_key: key,
      content_type: "audio/mpeg",
      size: AUDIO.byteLength,
      transcript_status: "pending",
    });
    expect(row!.twilio_deleted_at).not.toBeNull();

    const object = await env.RECORDINGS.get(key);
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(AUDIO);
    expect(object!.httpMetadata?.contentType).toBe("audio/mpeg");

    // Downloaded from our own account's API with the API key, never from the posted RecordingUrl.
    const download = seen.find((s) => s.method === "GET");
    expect(download?.url).toBe(`${TWILIO}/Recordings/${recordingSid}.mp3`);
    expect(download?.auth).toMatch(/^Basic /);
    expect(seen.filter((s) => s.method === "DELETE").map((s) => s.url)).toEqual([
      `${TWILIO}/Recordings/${recordingSid}.json`,
    ]);
    expect(sent).toEqual([{ voicemailId: row!.id }]);
    expect(numberId).toBeTruthy();
  });

  it("processes a retried callback once", async () => {
    const seen = mockTwilio();
    const { call } = await setup();
    const recordingSid = sid("RE");
    expect((await callback(call.callSid, recordingSid)).status).toBe(204);
    await until(rows, (r) => Boolean(r[0]?.twilio_deleted_at));
    expect((await callback(call.callSid, recordingSid)).status).toBe(204);
    await new Promise((r) => setTimeout(r, 100));
    expect(await rows()).toHaveLength(1);
    expect(seen.filter((s) => s.method === "GET")).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("ignores callbacks that are not a completed recording", async () => {
    const seen = mockTwilio();
    const { call } = await setup();
    const res = await callback(call.callSid, sid("RE"), { RecordingStatus: "absent" });
    expect(res.status).toBe(204);
    expect(await rows()).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  it("keeps the Twilio copy when the download fails, and the cron finishes it", async () => {
    let fail = true;
    const seen = mockTwilio(() =>
      fail
        ? new Response("{}", { status: 500 })
        : new Response(AUDIO, { headers: { "content-type": "audio/mpeg" } }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { call } = await setup();
    expect((await callback(call.callSid, sid("RE"))).status).toBe(204);

    const [failed] = await until(rows, (r) => (r[0]?.store_attempts ?? 0) > 0);
    expect(failed).toMatchObject({ r2_key: null, twilio_deleted_at: null, store_attempts: 1 });
    expect(failed!.store_error).toBeTruthy();
    expect(seen.some((s) => s.method === "DELETE")).toBe(false);
    expect(sent).toHaveLength(0);

    // Too fresh for the cron: it leaves the row to the callback's own attempt.
    await repairVoicemails(env, undefined, Date.now());
    expect((await rows())[0]!.store_attempts).toBe(1);

    fail = false;
    expect(cronJobs).toContain(repairVoicemails);
    await repairVoicemails(env, undefined, Date.now() + STORE_RETRY_AFTER_MS + 1000);
    const [row] = await rows();
    expect(row!.r2_key).toBeTruthy();
    expect(row!.twilio_deleted_at).not.toBeNull();
    expect(row!.store_error).toBeNull();
    expect(sent).toEqual([{ voicemailId: row!.id }]);
  });

  it("retries the Twilio delete from the cron when it failed", async () => {
    let deleteFails = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      if (req.method === "DELETE")
        return deleteFails ? new Response("{}", { status: 503 }) : new Response(null, { status: 204 });
      return new Response(AUDIO, { headers: { "content-type": "audio/mpeg" } });
    });
    const { call } = await setup();
    expect((await callback(call.callSid, sid("RE"))).status).toBe(204);
    const [stored] = await until(rows, (r) => Boolean(r[0]?.r2_key));
    await new Promise((r) => setTimeout(r, 100));
    expect(stored!.twilio_deleted_at).toBeNull();
    deleteFails = false;
    await repairVoicemails(env);
    expect((await rows())[0]!.twilio_deleted_at).not.toBeNull();
  });
});

describe("transcription consumer", () => {
  it("transcribes through AI Gateway and stores the text", async () => {
    mockTwilio();
    const { owner, numberId } = await setup();
    const row = await storedVoicemail(owner.userId, numberId);
    const run = mockAi(async () => ({ text: " Hi, it's Sam. Call me back. " }));
    const { batch, acked, retried } = fakeBatch([{ body: { voicemailId: row.id }, attempts: 1 }]);
    await handleTranscribeBatch(batch, env);

    expect(acked).toEqual([0]);
    expect(retried).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
    const [model, input, options] = run.mock.calls[0]!;
    expect(model).toBe(TRANSCRIBE_MODEL);
    expect((input as { audio: string }).audio).toBe(btoa(String.fromCharCode(...AUDIO)));
    expect(options).toEqual({ gateway: { id: "default" } });
    const [after] = await rows();
    expect(after).toMatchObject({ transcript: "Hi, it's Sam. Call me back.", transcript_status: "done" });

    // A repeated message does not run the model again.
    await handleTranscribeBatch(fakeBatch([{ body: { voicemailId: row.id }, attempts: 1 }]).batch, env);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries with backoff, then marks the transcript failed and keeps the audio", async () => {
    mockTwilio();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { owner, numberId } = await setup();
    const row = await storedVoicemail(owner.userId, numberId);
    mockAi(async () => {
      throw new Error("model unavailable");
    });

    const first = fakeBatch([{ body: { voicemailId: row.id }, attempts: 1 }]);
    await handleTranscribeBatch(first.batch, env);
    expect(first.acked).toEqual([]);
    expect(first.retried).toEqual([{ index: 0, delaySeconds: 30 }]);
    expect((await rows())[0]).toMatchObject({
      transcript_status: "pending",
      transcript_error: "model unavailable",
    });

    const third = fakeBatch([{ body: { voicemailId: row.id }, attempts: 3 }]);
    await handleTranscribeBatch(third.batch, env);
    expect(third.retried[0]!.delaySeconds).toBe(120);

    const last = fakeBatch([{ body: { voicemailId: row.id }, attempts: TRANSCRIBE_MAX_RETRIES + 1 }]);
    await handleTranscribeBatch(last.batch, env);
    expect(last.acked).toEqual([0]);
    expect(last.retried).toEqual([]);
    const [failed] = await rows();
    expect(failed!.transcript_status).toBe("failed");
    expect(failed!.r2_key).toBeTruthy();

    // Still playable.
    const audio = await owner.fetch(`/api/voicemails/${row.id}/audio`);
    expect(audio.status).toBe(200);
    await audio.arrayBuffer();

    // And the owner can queue it again.
    sent = [];
    expect((await owner.fetch(`/api/voicemails/${row.id}/transcribe`, { method: "POST" })).status).toBe(202);
    expect(sent).toEqual([{ voicemailId: row.id }]);
    expect((await rows())[0]!.transcript_status).toBe("pending");
    expect((await owner.fetch(`/api/voicemails/${row.id}/transcribe`, { method: "POST" })).status).toBe(409);
  });

  it("acks messages it cannot use", async () => {
    const { batch, acked } = fakeBatch([
      { body: "garbage", attempts: 1 },
      { body: { voicemailId: "missing" }, attempts: 1 },
    ]);
    await handleTranscribeBatch(batch, env);
    expect(acked).toEqual([0, 1]);
  });
});

describe("voicemail API", () => {
  it("needs the owner session", async () => {
    const anon = new Session();
    expect((await anon.fetch("/api/voicemails")).status).toBe(401);
    expect((await anon.fetch("/api/voicemails/x/audio")).status).toBe(401);
  });

  it("lists, searches and counts unheard voicemail of this owner only", async () => {
    mockTwilio();
    const { owner, numberId } = await setup();
    const a = await storedVoicemail(owner.userId, numberId);
    const b = await storedVoicemail(owner.userId, numberId);
    await env.DB.prepare(
      "UPDATE voicemails SET transcript = 'about the invoice', transcript_status = 'done' WHERE id = ?",
    )
      .bind(a.id)
      .run();

    const other = await otherUser();
    const otherNumber = await addNumber(other);
    const theirs = await storedVoicemail(other, otherNumber);

    // The caller is in the owner's contacts, and in the other account's under another name.
    for (const [ownerId, name] of [
      [owner.userId, "Sam"],
      [other, "Not yours"],
    ] as const) {
      const contactId = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO contacts (id, owner_id, display_name, sort_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).bind(contactId, ownerId, name, name.toLowerCase(), Date.now(), Date.now()),
        env.DB.prepare("INSERT INTO contact_numbers (id, contact_id, e164) VALUES (?, ?, ?)").bind(
          crypto.randomUUID(),
          contactId,
          CALLER,
        ),
      ]);
    }

    const list = await owner.get("/api/voicemails");
    expect(list.items.map((v: { id: string }) => v.id).sort()).toEqual([a.id, b.id].sort());
    expect(list.unheard).toBe(2);
    expect(list.items[0]).toMatchObject({ audioReady: true, from: CALLER, contactName: "Sam" });

    const page = await owner.get("/api/voicemails?limit=1");
    expect(page.items).toHaveLength(1);
    const next = await owner.get(`/api/voicemails?limit=1&cursor=${page.nextCursor}`);
    expect(next.items).toHaveLength(1);
    expect(next.items[0].id).not.toBe(page.items[0].id);
    expect(next.nextCursor).toBeNull();

    const found = await owner.get("/api/voicemails?q=invoice");
    expect(found.items.map((v: { id: string }) => v.id)).toEqual([a.id]);
    const literal = await owner.get("/api/voicemails?q=%25");
    expect(literal.items).toHaveLength(0);

    // Someone else's voicemail does not exist for this owner.
    expect((await owner.fetch(`/api/voicemails/${theirs.id}/audio`)).status).toBe(404);
    expect((await owner.fetch(`/api/voicemails/${theirs.id}/listened`, { method: "POST" })).status).toBe(404);
    expect((await owner.fetch(`/api/voicemails/${theirs.id}/transcribe`, { method: "POST" })).status).toBe(
      404,
    );
    expect((await owner.fetch(`/api/voicemails/${theirs.id}`, { method: "DELETE" })).status).toBe(404);
    expect(await env.RECORDINGS.head(theirs.r2_key!)).not.toBeNull();

    expect((await owner.fetch(`/api/voicemails/${a.id}/listened`, { method: "POST" })).status).toBe(204);
    expect((await owner.get("/api/voicemails")).unheard).toBe(1);
  });

  it("streams the audio with Range support and no caching", async () => {
    mockTwilio();
    const { owner, numberId } = await setup();
    const row = await storedVoicemail(owner.userId, numberId);
    const url = `/api/voicemails/${row.id}/audio`;

    const full = await owner.fetch(url);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("audio/mpeg");
    expect(full.headers.get("cache-control")).toBe("private, no-store");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(AUDIO);

    const part = await owner.fetch(url, { headers: { range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 2-5/${AUDIO.byteLength}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(AUDIO.slice(2, 6));

    const tail = await owner.fetch(url, { headers: { range: "bytes=-3" } });
    expect(tail.status).toBe(206);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(AUDIO.slice(-3));

    const bad = await owner.fetch(url, { headers: { range: "bytes=999-" } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe(`bytes */${AUDIO.byteLength}`);
  });

  it("deletes the audio and the row", async () => {
    mockTwilio();
    const { owner, numberId } = await setup();
    const row = await storedVoicemail(owner.userId, numberId);
    expect((await owner.fetch(`/api/voicemails/${row.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await rows()).toHaveLength(0);
    expect(await env.RECORDINGS.head(row.r2_key!)).toBeNull();
  });

  it("saves the retention setting", async () => {
    const { owner } = await setup();
    expect(await owner.get("/api/voicemails/settings")).toEqual({ retentionDays: 90 });
    expect(await owner.json("PUT", "/api/voicemails/settings", { retentionDays: 0 })).toEqual({
      retentionDays: 0,
    });
    expect(await owner.get("/api/voicemails/settings")).toEqual({ retentionDays: 0 });
    await owner.json("PUT", "/api/voicemails/settings", { retentionDays: -1 }, 400);
  });
});

describe("retention", () => {
  it("deletes voicemail older than the owner's setting from R2, Twilio and D1", async () => {
    const seen = mockTwilio();
    const { owner, numberId } = await setup();
    const old = await storedVoicemail(owner.userId, numberId);
    const fresh = await storedVoicemail(owner.userId, numberId);
    await env.DB.prepare("UPDATE voicemails SET created_at = ? WHERE id = ?")
      .bind(Date.now() - 91 * DAY, old.id)
      .run();
    expect(cronJobs).toContain(pruneVoicemails);

    await pruneVoicemails(env);
    expect((await rows()).map((r) => r.id)).toEqual([fresh.id]);
    expect(await env.RECORDINGS.head(old.r2_key!)).toBeNull();
    expect(await env.RECORDINGS.head(fresh.r2_key!)).not.toBeNull();
    expect(seen.length).toBeGreaterThan(0);
  });

  it("keeps everything when retention is 0 and uses each owner's own days", async () => {
    mockTwilio();
    const { owner, numberId } = await setup();
    const mine = await storedVoicemail(owner.userId, numberId);
    const other = await otherUser();
    const theirs = await storedVoicemail(other, await addNumber(other));
    await env.DB.prepare("UPDATE voicemails SET created_at = ?")
      .bind(Date.now() - 400 * DAY)
      .run();
    await owner.json("PUT", "/api/voicemails/settings", { retentionDays: 0 });

    await pruneVoicemails(env);
    expect((await rows()).map((r) => r.id)).toEqual([mine.id]);
    expect(await env.RECORDINGS.head(theirs.r2_key!)).toBeNull();
  });

  it("removes the Twilio copy of a voicemail that never reached R2", async () => {
    const seen = mockTwilio(() => new Response("{}", { status: 500 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { owner, call } = await setup();
    await owner.json("PUT", "/api/voicemails/settings", { retentionDays: 1 });
    await callback(call.callSid, sid("RE"));
    await until(rows, (r) => (r[0]?.store_attempts ?? 0) > 0);
    await pruneVoicemails(env, undefined, Date.now() + 2 * DAY);
    expect(await rows()).toHaveLength(0);
    expect(seen.some((s) => s.method === "DELETE")).toBe(true);
  });
});

describe("parseRange", () => {
  it("reads single byte ranges", () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange("bytes=0-", 10)).toEqual({ offset: 0, length: 10 });
    expect(parseRange("bytes=3-100", 10)).toEqual({ offset: 3, length: 7 });
    expect(parseRange("bytes=-4", 10)).toEqual({ offset: 6, length: 4 });
    expect(parseRange("bytes=-40", 10)).toEqual({ offset: 0, length: 10 });
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=5-2", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(parseRange("items=0-1", 10)).toBeNull();
  });
});
