import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onTranscriptReady, runSummaryJob, type SummaryJob } from "../../src/worker/lib/ai/summary";
import { SUMMARY_MODEL } from "../../src/worker/lib/ai/summary-prompt";
import { handleTranscribeBatch, TRANSCRIBE_MODEL } from "../../src/worker/lib/voicemail";
import { createOwner, resetDb, type Session } from "./helpers";

const CALLER = "+14155552671";
const TRANSCRIPT = "Hi, it's Sam from Acme. Please call me back on 0400 111 222 about the quote.";
const REPLY = {
  summary: "Sam from Acme called about the quote.",
  actionItems: ["Call Sam back on 0400 111 222"],
  oneLiner: "Sam from Acme wants a call back about the quote",
};

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

/** Workers AI stub: Whisper answers with `transcript`, the summary model with `summary` in the chat shape. */
function mockAi(summary: () => unknown = () => JSON.stringify(REPLY), transcript = TRANSCRIPT) {
  const run = vi.fn(async (model: string, _input: unknown, _options: unknown) => {
    if (model === TRANSCRIBE_MODEL) return { text: transcript };
    return { choices: [{ message: { role: "assistant", content: summary() } }] };
  });
  (env as { AI: unknown }).AI = { run };
  return run;
}
const summaryCalls = (run: ReturnType<typeof mockAi>) => run.mock.calls.filter(([m]) => m === SUMMARY_MODEL);

let seq = 0;
const sid = (prefix: string) => `${prefix}${String(++seq).padStart(32, "0")}`;

/** A call with a stored, not yet transcribed voicemail, inserted directly. */
async function voicemail(ownerId: string) {
  const callId = crypto.randomUUID();
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO calls (id, owner_id, twilio_call_sid, direction, party, status, outcome, started_at, created_at, updated_at) VALUES (?, ?, ?, 'inbound', ?, 'completed', 'voicemail', ?, ?, ?)",
  )
    .bind(callId, ownerId, sid("CA"), CALLER, now, now, now)
    .run();
  const key = `voicemail/${ownerId}/${callId}.mp3`;
  await env.RECORDINGS.put(key, new Uint8Array([1, 2, 3]));
  await env.DB.prepare(
    'INSERT INTO voicemails (id, owner_id, call_id, "from", twilio_recording_sid, r2_key, twilio_deleted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, ownerId, callId, CALLER, sid("RE"), key, now, now)
    .run();
  return { id, callId };
}

async function otherUser() {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Other', ?, 0, ?, ?)",
  )
    .bind(id, `${id}@other.test`, Date.now(), Date.now())
    .run();
  return id;
}

function batch(bodies: unknown[]) {
  const acked: number[] = [];
  const retried: number[] = [];
  const b = {
    queue: "talvuno-transcribe",
    messages: bodies.map((body, index) => ({
      id: String(index),
      timestamp: new Date(),
      body,
      attempts: 1,
      ack: () => void acked.push(index),
      retry: () => void retried.push(index),
    })),
    ackAll() {},
    retryAll() {},
  } as unknown as MessageBatch<unknown>;
  return { b, acked, retried };
}

/** Transcribes `voicemailId`, then delivers the summary jobs that queued. */
async function transcribeAndSummarise(voicemailId: string) {
  await handleTranscribeBatch(batch([{ voicemailId }]).b, env);
  const jobs = sent.splice(0);
  const run = batch(jobs);
  await handleTranscribeBatch(run.b, env);
  return { jobs, acked: run.acked, retried: run.retried };
}

type SummaryRaw = {
  owner_id: string;
  source_kind: string;
  source_id: string;
  summary: string | null;
  action_items: string | null;
  one_liner: string | null;
  model: string;
  status: string;
};
const summaries = async () =>
  (await env.DB.prepare("SELECT * FROM ai_summaries ORDER BY created_at").all<SummaryRaw>()).results;

describe("summary pipeline", () => {
  it("summarises a voicemail transcript once, through AI Gateway, as its own queue job", async () => {
    const owner = await createOwner();
    const vm = await voicemail(owner.userId);
    const run = mockAi();
    const { jobs, acked, retried } = await transcribeAndSummarise(vm.id);

    expect(jobs).toEqual([{ type: "summary", summaryId: expect.any(String), transcript: TRANSCRIPT }]);
    expect(acked).toEqual([0]);
    expect(retried).toEqual([]);
    expect(summaryCalls(run)).toHaveLength(1);
    const [, input, options] = summaryCalls(run)[0]!;
    expect(options).toEqual({ gateway: { id: "default" } });
    expect(JSON.stringify(input)).toContain(TRANSCRIPT);
    const [row] = await summaries();
    expect(row).toMatchObject({
      owner_id: owner.userId,
      source_kind: "voicemail",
      source_id: vm.id,
      summary: REPLY.summary,
      one_liner: REPLY.oneLiner,
      model: SUMMARY_MODEL,
      status: "done",
    });
    expect(JSON.parse(row!.action_items!)).toEqual(REPLY.actionItems);

    // The hook firing again for the same transcript, or the job being delivered twice, does nothing.
    await onTranscriptReady(env, undefined, {
      kind: "voicemail",
      id: vm.id,
      ownerId: owner.userId,
      transcript: TRANSCRIPT,
    });
    expect(sent).toEqual([]);
    await handleTranscribeBatch(batch(jobs).b, env);
    expect(summaryCalls(run)).toHaveLength(1);
    expect(await summaries()).toHaveLength(1);
  });

  it("sends nothing to the model when summaries are off", async () => {
    const owner = await createOwner();
    await owner.json("PUT", "/api/ai-summaries/settings", { enabled: false });
    const vm = await voicemail(owner.userId);
    const run = mockAi();
    const { jobs } = await transcribeAndSummarise(vm.id);

    expect(jobs).toEqual([]);
    expect(summaryCalls(run)).toHaveLength(0);
    expect(await summaries()).toEqual([]);
    // The transcript itself is saved as before.
    const row = await env.DB.prepare("SELECT transcript_status FROM voicemails WHERE id = ?")
      .bind(vm.id)
      .first<{ transcript_status: string }>();
    expect(row!.transcript_status).toBe("done");
  });

  it("does not call the model for a job queued before summaries were switched off", async () => {
    const owner = await createOwner();
    const vm = await voicemail(owner.userId);
    const run = mockAi();
    await handleTranscribeBatch(batch([{ voicemailId: vm.id }]).b, env);
    const jobs = sent.splice(0) as SummaryJob[];
    await owner.json("PUT", "/api/ai-summaries/settings", { enabled: false });
    expect(await runSummaryJob(env, jobs[0]!)).toBe("skipped");
    expect(summaryCalls(run)).toHaveLength(0);
    expect((await summaries())[0]!.status).toBe("failed");
  });

  it("falls back to no summary on a bad model reply and never retries or blocks the transcript", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = await createOwner();
    const bad = [
      () => "not json at all",
      () => JSON.stringify({ summary: 42, actionItems: [] }),
      () => JSON.stringify({ summary: "Fine.", actionItems: ["a", "b", "c", "d"], oneLiner: "x" }),
      () => JSON.stringify({ summary: "No one-liner on a voicemail.", actionItems: [] }),
      () => {
        throw new Error("model unavailable");
      },
    ];
    for (const reply of bad) {
      const vm = await voicemail(owner.userId);
      mockAi(reply);
      const { acked, retried } = await transcribeAndSummarise(vm.id);
      expect(acked).toEqual([0]);
      expect(retried).toEqual([]);
      const row = (await summaries()).find((s) => s.source_id === vm.id)!;
      expect(row).toMatchObject({ status: "failed", summary: null, one_liner: null });
      const t = await env.DB.prepare("SELECT transcript, transcript_status FROM voicemails WHERE id = ?")
        .bind(vm.id)
        .first<{ transcript: string; transcript_status: string }>();
      expect(t).toEqual({ transcript: TRANSCRIPT, transcript_status: "done" });
    }
    const list = await owner.get<{ items: { aiSummary: unknown }[] }>("/api/voicemails");
    expect(list.items.every((i) => i.aiSummary === null)).toBe(true);
  });

  it("says No message for a noise-only transcript without asking the model", async () => {
    const owner = await createOwner();
    const vm = await voicemail(owner.userId);
    const run = mockAi(undefined, "you ... [inaudible] ...");
    const { jobs } = await transcribeAndSummarise(vm.id);
    expect(jobs).toEqual([]);
    expect(summaryCalls(run)).toHaveLength(0);
    expect((await summaries())[0]).toMatchObject({
      status: "empty",
      summary: "No message",
      one_liner: "No message",
    });
  });

  it("deletes the summary with its voicemail", async () => {
    const owner = await createOwner();
    const vm = await voicemail(owner.userId);
    mockAi();
    await transcribeAndSummarise(vm.id);
    expect(await summaries()).toHaveLength(1);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("not mocked", { status: 599 }));
    expect((await owner.fetch(`/api/voicemails/${vm.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await summaries()).toEqual([]);
  });
});

describe("what the app is sent", () => {
  async function summarised(owner: Session & { userId: string }) {
    const vm = await voicemail(owner.userId);
    mockAi();
    await transcribeAndSummarise(vm.id);
    return vm;
  }

  it("puts the summary on the voicemail and the one-liner on its call", async () => {
    const owner = await createOwner();
    const vm = await summarised(owner);
    const list = await owner.get<{ items: Record<string, unknown>[] }>("/api/voicemails");
    expect(list.items[0]).toMatchObject({
      id: vm.id,
      aiSummary: { summary: REPLY.summary, actionItems: REPLY.actionItems, oneLiner: REPLY.oneLiner },
    });
    const calls = await owner.get<{ items: Record<string, unknown>[] }>("/api/calls");
    expect(calls.items.find((c) => c.id === vm.callId)).toMatchObject({ whatTheyWanted: REPLY.oneLiner });
  });

  it("sends null while there is no summary", async () => {
    const owner = await createOwner();
    const vm = await voicemail(owner.userId);
    const list = await owner.get<{ items: Record<string, unknown>[] }>("/api/voicemails");
    expect(list.items[0]).toMatchObject({ id: vm.id, aiSummary: null });
    const calls = await owner.get<{ items: Record<string, unknown>[] }>("/api/calls");
    expect(calls.items[0]).toMatchObject({ whatTheyWanted: null });
  });

  it("hides summaries made earlier once summaries are off, and shows them again when on", async () => {
    const owner = await createOwner();
    const vm = await summarised(owner);
    await owner.json("PUT", "/api/ai-summaries/settings", { enabled: false });
    const list = await owner.get<{ items: Record<string, unknown>[] }>("/api/voicemails");
    expect(list.items[0]).toMatchObject({ id: vm.id, aiSummary: null });
    const calls = await owner.get<{ items: Record<string, unknown>[] }>("/api/calls");
    expect(calls.items.find((c) => c.id === vm.callId)).toMatchObject({ whatTheyWanted: null });

    await owner.json("PUT", "/api/ai-summaries/settings", { enabled: true });
    const again = await owner.get<{ items: Record<string, unknown>[] }>("/api/voicemails");
    expect(again.items[0]).toMatchObject({ id: vm.id, aiSummary: { summary: REPLY.summary } });
  });

  it("drops a summary sentence or item whose figure is not in the transcript", async () => {
    const owner = await createOwner();
    const vm = await voicemail(owner.userId);
    mockAi(() =>
      JSON.stringify({
        summary: "Sam from Acme called about the quote. He gave 0400 111 223 as his number.",
        actionItems: ["Call Sam back on 0400 111 223", "Call Sam back about the quote"],
        oneLiner: "Sam from Acme wants a call back on 0400 111 223",
      }),
    );
    await transcribeAndSummarise(vm.id);
    const list = await owner.get<{ items: Record<string, unknown>[] }>("/api/voicemails");
    expect(list.items[0]).toMatchObject({
      aiSummary: {
        summary: "Sam from Acme called about the quote.",
        actionItems: ["Call Sam back about the quote"],
        oneLiner: null,
      },
    });
  });

  it("keeps summaries to their owner", async () => {
    const owner = await createOwner();
    const other = await otherUser();
    const theirs = await voicemail(other);
    mockAi();
    await transcribeAndSummarise(theirs.id);
    expect((await summaries())[0]).toMatchObject({ owner_id: other, status: "done" });

    // A summary row naming the owner's voicemail id under someone else's account is never shown to the owner.
    const mine = await voicemail(owner.userId);
    await env.DB.prepare(
      "INSERT INTO ai_summaries (id, owner_id, source_kind, source_id, summary, action_items, one_liner, model, status, created_at, updated_at) VALUES (?, ?, 'voicemail', ?, 'Theirs', '[]', 'Theirs', ?, 'done', ?, ?)",
    )
      .bind(crypto.randomUUID(), other, mine.id, SUMMARY_MODEL, Date.now(), Date.now())
      .run();
    const list = await owner.get<{ items: Record<string, unknown>[] }>("/api/voicemails");
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: mine.id, aiSummary: null });
    const calls = await owner.get<{ items: Record<string, unknown>[] }>("/api/calls");
    expect(calls.items.map((c) => c.whatTheyWanted)).toEqual([null]);
  });

  it("stores the setting per owner, on by default", async () => {
    const owner = await createOwner();
    expect(await owner.get("/api/ai-summaries/settings")).toEqual({ enabled: true });
    await owner.json("PUT", "/api/ai-summaries/settings", { enabled: false });
    expect(await owner.get("/api/ai-summaries/settings")).toEqual({ enabled: false });
    await owner.json("PUT", "/api/ai-summaries/settings", { enabled: "yes" }, 400);
  });
});
