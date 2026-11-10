import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createOwner, resetDb } from "./helpers";

let seq = 0;
const now = Date.now();

async function addCall(ownerId: string, party: string) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO calls (id, owner_id, twilio_call_sid, direction, party, status, started_at, created_at, updated_at) VALUES (?, ?, ?, 'inbound', ?, 'completed', ?, ?, ?)",
  )
    .bind(id, ownerId, `CA${String(++seq).padStart(32, "0")}`, party, now - seq, now, now)
    .run();
  return id;
}

async function addRecording(ownerId: string, callId: string, transcript: string | null) {
  await env.DB.prepare(
    "INSERT INTO call_recordings (id, owner_id, call_id, twilio_recording_sid, transcript, transcript_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      ownerId,
      callId,
      `RE${String(++seq).padStart(32, "0")}`,
      transcript,
      transcript ? "done" : "pending",
      now,
    )
    .run();
}

async function addDefaultNumber(ownerId: string, e164: string) {
  await env.DB.prepare(
    "INSERT INTO phone_numbers (id, owner_id, e164, twilio_sid, friendly_name, capabilities, is_default, released_at, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, 1, NULL, ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      ownerId,
      e164,
      `PN${String(++seq).padStart(32, "0")}`,
      JSON.stringify({ voice: true, sms: true, mms: false }),
      now,
      now,
    )
    .run();
}

async function addContact(ownerId: string, name: string, e164: string) {
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO contacts (id, owner_id, display_name, sort_key, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)",
    ).bind(id, ownerId, name, now, now),
    env.DB.prepare("INSERT INTO contact_numbers (id, contact_id, e164) VALUES (?, ?, ?)").bind(
      crypto.randomUUID(),
      id,
      e164,
    ),
  ]);
}

async function addOtherOwner() {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, 'Other', 'other@talvuno.test', ?, ?)",
  )
    .bind(id, now, now)
    .run();
  return id;
}

type Owner = Awaited<ReturnType<typeof createOwner>>;
type Item = { id: string; recorded: boolean };
const search = async (owner: Owner, q: string) =>
  (await owner.get(`/api/calls?q=${encodeURIComponent(q)}`)).items as Item[];

beforeEach(resetDb);

describe("recents search over call transcripts", () => {
  it("returns a call whose recording transcript matches, flagged as recorded", async () => {
    const owner = await createOwner();
    const hit = await addCall(owner.userId, "+14155550101");
    const miss = await addCall(owner.userId, "+14155550102");
    await addRecording(owner.userId, hit, "Please send the invoice on Tuesday");
    await addRecording(owner.userId, miss, "Nothing about that");
    const items = await search(owner, "INVOICE");
    expect(items.map((i) => i.id)).toEqual([hit]);
    expect(items[0]!.recorded).toBe(true);
  });

  it("returns a call once even when several recordings match", async () => {
    const owner = await createOwner();
    const call = await addCall(owner.userId, "+14155550101");
    await addRecording(owner.userId, call, "invoice one");
    await addRecording(owner.userId, call, "invoice two");
    expect((await search(owner, "invoice")).map((i) => i.id)).toEqual([call]);
  });

  it("never matches another owner's transcript", async () => {
    const owner = await createOwner();
    const otherId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, 'Other', 'other@talvuno.test', ?, ?)",
    )
      .bind(otherId, now, now)
      .run();
    const theirs = await addCall(otherId, "+14155550199");
    await addRecording(otherId, theirs, "secret invoice");
    expect(await search(owner, "invoice")).toEqual([]);
    // A recording row of another owner attached to this owner's call does not match either.
    const mine = await addCall(owner.userId, "+14155550101");
    await addRecording(otherId, mine, "stray invoice");
    expect(await search(owner, "invoice")).toEqual([]);
  });

  it("treats % and _ in the query as plain characters", async () => {
    const owner = await createOwner();
    const pct = await addCall(owner.userId, "+14155550101");
    const other = await addCall(owner.userId, "+14155550102");
    await addRecording(owner.userId, pct, "a 50% discount");
    await addRecording(owner.userId, other, "a 50 dollar discount");
    expect((await search(owner, "50%")).map((i) => i.id)).toEqual([pct]);
    expect(await search(owner, "5_ ")).toEqual([]);
    expect((await search(owner, "%")).map((i) => i.id)).toEqual([pct]);
  });

  it("lists a recorded call without a transcript yet, but does not match it by text", async () => {
    const owner = await createOwner();
    const pending = await addCall(owner.userId, "+14155550101");
    await addRecording(owner.userId, pending, null);
    expect(await search(owner, "invoice")).toEqual([]);
    const all = (await owner.get("/api/calls")).items as Item[];
    expect(all).toEqual([expect.objectContaining({ id: pending, recorded: true })]);
    expect((await search(owner, "+1415555")).map((i) => i.id)).toEqual([pending]);
  });
});

describe("recents search by number and contact name", () => {
  it("finds a number typed in local format, in the default number's country", async () => {
    const owner = await createOwner();
    await addDefaultNumber(owner.userId, "+61255501234");
    const hit = await addCall(owner.userId, "+61412345678");
    await addCall(owner.userId, "+14155550101");
    expect((await search(owner, "0412 345")).map((i) => i.id)).toEqual([hit]);
    expect((await search(owner, "0412345678")).map((i) => i.id)).toEqual([hit]);
  });

  it("uses the typed numerals only when there is no default number", async () => {
    const owner = await createOwner();
    const hit = await addCall(owner.userId, "+61412345678");
    expect(await search(owner, "0412 345")).toEqual([]);
    expect((await search(owner, "412 345")).map((i) => i.id)).toEqual([hit]);
  });

  it("finds spaced, dashed and bracketed numbers, with or without the plus", async () => {
    const owner = await createOwner();
    const hit = await addCall(owner.userId, "+14155550101");
    await addCall(owner.userId, "+14155550202");
    for (const q of ["+1 415 555 0101", "(415) 555-0101", "1415555 0101"])
      expect((await search(owner, q)).map((i) => i.id)).toEqual([hit]);
  });

  it("finds a call by the name of the contact saved for its number", async () => {
    const owner = await createOwner();
    const hit = await addCall(owner.userId, "+14155550101");
    await addCall(owner.userId, "+14155550102");
    await addContact(owner.userId, "Priya Sharma", "+14155550101");
    expect((await search(owner, "priya")).map((i) => i.id)).toEqual([hit]);
  });

  it("does not match another owner's contact name or call", async () => {
    const owner = await createOwner();
    const otherId = await addOtherOwner();
    await addCall(otherId, "+14155550199");
    await addContact(otherId, "Priya Sharma", "+14155550101");
    await addCall(owner.userId, "+14155550101");
    expect(await search(owner, "priya")).toEqual([]);
    expect(await search(owner, "4155550199")).toEqual([]);
  });

  it("keeps escaping wildcards in names and does not read words as numbers", async () => {
    const owner = await createOwner();
    await addCall(owner.userId, "+14155550101");
    await addContact(owner.userId, "Pri_ya", "+14155550101");
    expect(await search(owner, "Pri%")).toEqual([]);
    expect((await search(owner, "pri_")).length).toBe(1);
    expect(await search(owner, "5_")).toEqual([]);
  });
});

describe("recents search over AI summaries of call recordings", () => {
  async function addSummary(ownerId: string, callId: string, summary: string) {
    const rec = await env.DB.prepare("SELECT id FROM call_recordings WHERE call_id = ?")
      .bind(callId)
      .first<{ id: string }>();
    await env.DB.prepare(
      "INSERT INTO ai_summaries (id, owner_id, source_kind, source_id, summary, action_items, one_liner, model, status, created_at, updated_at) VALUES (?, ?, 'call', ?, ?, '[]', NULL, 'test-model', 'done', ?, ?)",
    )
      .bind(crypto.randomUUID(), ownerId, rec!.id, summary, now, now)
      .run();
  }

  it("matches summary text while summaries are on, and not once they are off", async () => {
    const owner = await createOwner();
    const hit = await addCall(owner.userId, "+14155550101");
    const miss = await addCall(owner.userId, "+14155550102");
    // The transcripts say nothing about the word searched for: only the summary does.
    await addRecording(owner.userId, hit, "talked about the thing");
    await addRecording(owner.userId, miss, "talked about another thing");
    await addSummary(owner.userId, hit, "Agreed a refund for the broken heater");
    expect((await search(owner, "heater")).map((i) => i.id)).toEqual([hit]);

    await owner.json("PUT", "/api/ai-summaries/settings", { enabled: false });
    expect(await search(owner, "heater")).toEqual([]);
    // The transcript still matches with summaries off.
    expect((await search(owner, "another thing")).map((i) => i.id)).toEqual([miss]);

    await owner.json("PUT", "/api/ai-summaries/settings", { enabled: true });
    expect((await search(owner, "heater")).map((i) => i.id)).toEqual([hit]);
  });
});
