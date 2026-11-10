import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createOwner, resetDb } from "./helpers";
import { signedTwilioPost } from "./twilio-helpers";

const OUR = "+14155550100";
const peer = (n: number) => `+1415555260${n}`;

beforeEach(resetDb);

async function setup() {
  const s = await createOwner();
  const numberId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO phone_numbers (id, owner_id, e164, twilio_sid, friendly_name, capabilities, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, 0, ?, ?)",
  )
    .bind(
      numberId,
      s.userId,
      OUR,
      `PN${crypto.randomUUID().replace(/-/g, "")}`,
      JSON.stringify({ voice: true, sms: true, mms: false }),
      Date.now(),
      Date.now(),
    )
    .run();
  return s;
}

let counter = 0;
const inbound = (from: string, body = "hello") =>
  signedTwilioPost("/api/twilio/sms/inbound", {
    MessageSid: `SM${(++counter).toString(16).padStart(32, "0")}`,
    AccountSid: "AC00000000000000000000000000000000",
    From: from,
    To: OUR,
    Body: body,
    NumMedia: "0",
  });

type Item = { id: string; participant: string; pinnedAt: number | null; archivedAt: number | null };
const list = async (s: Awaited<ReturnType<typeof setup>>, query = "") =>
  (await s.get(`/api/messages/conversations${query}`)).items as Item[];

/** Three threads, newest activity last: peer(1) oldest, peer(3) newest. Returns ids by peer number. */
async function threeThreads(s: Awaited<ReturnType<typeof setup>>) {
  for (const n of [1, 2, 3]) {
    await inbound(peer(n));
    // Distinct millisecond timestamps keep the activity order stable.
    await new Promise((r) => setTimeout(r, 5));
  }
  const items = await list(s);
  const id = (n: number) => items.find((i) => i.participant === peer(n))!.id;
  return { 1: id(1), 2: id(2), 3: id(3) };
}

describe("pin, archive and unread", () => {
  it("lists newest activity first and puts pinned threads on top, newest pin first", async () => {
    const s = await setup();
    const t = await threeThreads(s);
    expect((await list(s)).map((i) => i.id)).toEqual([t[3], t[2], t[1]]);

    await s.post(`/api/messages/conversations/${t[1]}/pin`, { pinned: true });
    await new Promise((r) => setTimeout(r, 5));
    await s.post(`/api/messages/conversations/${t[2]}/pin`, { pinned: true });
    const ordered = await list(s);
    expect(ordered.map((i) => i.id)).toEqual([t[2], t[1], t[3]]);
    expect(ordered[0]!.pinnedAt).toBeGreaterThan(0);

    await s.post(`/api/messages/conversations/${t[2]}/pin`, { pinned: false });
    expect((await list(s)).map((i) => i.id)).toEqual([t[1], t[3], t[2]]);
  });

  it("archives out of the main list into an archived view, and unarchives", async () => {
    const s = await setup();
    const t = await threeThreads(s);
    await s.post(`/api/messages/conversations/${t[2]}/archive`, { archived: true });
    expect((await list(s)).map((i) => i.id)).toEqual([t[3], t[1]]);
    const archived = await list(s, "?archived=1");
    expect(archived.map((i) => i.id)).toEqual([t[2]]);
    expect(archived[0]!.archivedAt).toBeGreaterThan(0);

    await s.post(`/api/messages/conversations/${t[2]}/archive`, { archived: false });
    expect((await list(s, "?archived=1")).length).toBe(0);
    expect((await list(s)).map((i) => i.id)).toEqual([t[3], t[2], t[1]]);
  });

  it("keeps pinned and archived apart: archiving unpins, pinning un-archives", async () => {
    const s = await setup();
    const t = await threeThreads(s);
    await s.post(`/api/messages/conversations/${t[1]}/pin`, { pinned: true });
    const archived = await s.post(`/api/messages/conversations/${t[1]}/archive`, { archived: true });
    expect(archived).toMatchObject({ pinnedAt: null });
    expect(archived.archivedAt).toBeGreaterThan(0);
    const pinned = await s.post(`/api/messages/conversations/${t[1]}/pin`, { pinned: true });
    expect(pinned).toMatchObject({ archivedAt: null });
    expect((await list(s))[0]!.id).toBe(t[1]);
  });

  it("brings an archived thread back when a new message arrives, and an outbound one does not", async () => {
    const s = await setup();
    const t = await threeThreads(s);
    await s.post(`/api/messages/conversations/${t[1]}/archive`, { archived: true });
    expect((await list(s)).map((i) => i.id)).not.toContain(t[1]);
    await inbound(peer(1), "are you there?");
    const back = await list(s);
    expect(back[0]).toMatchObject({ id: t[1], archivedAt: null });
    expect((await list(s, "?archived=1")).length).toBe(0);
  });

  it("marks a thread unread by hand and clears it when the thread is read", async () => {
    const s = await setup();
    const t = await threeThreads(s);
    await s.post(`/api/messages/conversations/${t[1]}/read`);
    const read = await s.get(`/api/messages/conversations/${t[1]}`);
    expect(read).toMatchObject({ unreadCount: 0, markedUnread: false });

    const marked = await s.post(`/api/messages/conversations/${t[1]}/unread`, { unread: true });
    expect(marked).toMatchObject({ unreadCount: 0, markedUnread: true });
    await s.post(`/api/messages/conversations/${t[1]}/read`);
    expect(await s.get(`/api/messages/conversations/${t[1]}`)).toMatchObject({ markedUnread: false });

    await s.post(`/api/messages/conversations/${t[1]}/unread`, { unread: true });
    await s.post(`/api/messages/conversations/${t[1]}/unread`, { unread: false });
    expect(await s.get(`/api/messages/conversations/${t[1]}`)).toMatchObject({ markedUnread: false });
  });

  it("only changes the owner's own threads and checks the body", async () => {
    const s = await setup();
    const t = await threeThreads(s);
    for (const [path, body] of [
      ["pin", { pinned: true }],
      ["archive", { archived: true }],
      ["unread", { unread: true }],
    ] as const)
      await s.post(`/api/messages/conversations/nope/${path}`, body, 404);
    await s.post(`/api/messages/conversations/${t[1]}/pin`, { pinned: "yes" }, 400);
    await s.post(`/api/messages/conversations/${t[1]}/archive`, {}, 400);

    // A thread of another owner is not found either.
    await env.DB.prepare(
      "INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('other', 'Other', 'other@talvuno.test', ?, ?)",
    )
      .bind(Date.now(), Date.now())
      .run();
    const numbers = await env.DB.prepare("SELECT id FROM phone_numbers").all<{ id: string }>();
    await env.DB.prepare(
      "INSERT INTO conversations (id, owner_id, number_id, participant, created_at, updated_at) VALUES ('theirs', 'other', ?, '+14155559999', ?, ?)",
    )
      .bind(numbers.results[0]!.id, Date.now(), Date.now())
      .run();
    await s.post("/api/messages/conversations/theirs/pin", { pinned: true }, 404);
    expect((await list(s)).some((i) => i.id === "theirs")).toBe(false);
  });
});
