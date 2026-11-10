import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cronJobs } from "../../src/worker/cron";
import { createDb } from "../../src/worker/db";
import { digestCounts, sendDigests } from "../../src/worker/lib/digest";
import { b64u, decryptWebPush, newReceiver, newVapid, type Receiver, text } from "../unit/webpush-decrypt";
import { createOwner, resetDb, type Session } from "./helpers";

declare global {
  namespace Cloudflare {
    interface Env {
      VAPID_PUBLIC_KEY?: string;
      VAPID_PRIVATE_KEY?: string;
      VAPID_SUBJECT?: string;
    }
  }
}

beforeEach(async () => {
  await resetDb();
  const vapid = await newVapid();
  env.VAPID_PUBLIC_KEY = vapid.publicKey;
  env.VAPID_PRIVATE_KEY = vapid.privateKey;
  env.VAPID_SUBJECT = vapid.subject;
});

afterEach(async () => {
  vi.restoreAllMocks();
  env.VAPID_PUBLIC_KEY = undefined;
  env.VAPID_PRIVATE_KEY = undefined;
  env.VAPID_SUBJECT = undefined;
});

const HOUR = 3_600_000;
// 2026-06-10 12:00 UTC is 08:00 in New York (daylight time).
const EIGHT_NY = Date.parse("2026-06-10T12:00:00Z");

let receiver: Receiver;
let bodies: BodyInit[] = [];

async function setup(timezone = "America/New_York", digestTime = "08:00") {
  const s = await createOwner();
  await s.json("PUT", "/api/preferences", { digestEnabled: true, digestTime, timezone });
  receiver = await newReceiver();
  const r = receiver;
  await env.DB.prepare(
    "INSERT INTO push_subscriptions (id, owner_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      s.userId,
      "https://push.example.test/send/digest",
      b64u.encode(r.publicKey),
      b64u.encode(r.authSecret),
      Date.now(),
    )
    .run();
  return s;
}

function pushService() {
  const sent: string[] = [];
  bodies = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    bodies.push(init?.body as BodyInit);
    sent.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    return new Response(null, { status: 201 });
  });
  return sent;
}

async function addNumber(ownerId: string) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO phone_numbers (id, owner_id, e164, twilio_sid, capabilities, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, '{"voice":true,"sms":true,"mms":false}', 0, 0, 0)`,
  )
    .bind(id, ownerId, `+1555${Math.floor(Math.random() * 1e7)}`, `PN${id}`)
    .run();
  return id;
}

async function addMissed(ownerId: string, startedAt: number, status = "no-answer") {
  await env.DB.prepare(
    `INSERT INTO calls (id, owner_id, twilio_call_sid, direction, party, status, started_at, created_at, updated_at)
     VALUES (?, ?, ?, 'inbound', '+15550001', ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), ownerId, `CA${crypto.randomUUID()}`, status, startedAt, startedAt, startedAt)
    .run();
}

async function addUnread(ownerId: string, numberId: string, unread: number) {
  await env.DB.prepare(
    `INSERT INTO conversations (id, owner_id, number_id, participant, unread_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0)`,
  )
    .bind(crypto.randomUUID(), ownerId, numberId, `+1555${Math.floor(Math.random() * 1e7)}`, unread)
    .run();
}

async function seedActivity(ownerId: string, when: number) {
  const n = await addNumber(ownerId);
  await addMissed(ownerId, when - HOUR);
  await addMissed(ownerId, when - 2 * HOUR);
  await addUnread(ownerId, n, 5);
}

describe("sendDigests", () => {
  it("is registered as a cron job", () => {
    expect(cronJobs).toContain(sendDigests);
  });

  it("sends nothing before the chosen local time", async () => {
    const s = await setup();
    await seedActivity(s.userId, EIGHT_NY);
    const sent = pushService();
    await sendDigests(env, undefined, EIGHT_NY - 60_000);
    expect(sent).toEqual([]);
  });

  it("sends one push once the time has passed, with the counts", async () => {
    const s = await setup();
    await seedActivity(s.userId, EIGHT_NY);
    const sent = pushService();
    await sendDigests(env, undefined, EIGHT_NY + 60_000);
    expect(sent).toEqual(["https://push.example.test/send/digest"]);
    const plain = await decryptWebPush(new Uint8Array(bodies[0] as ArrayBuffer | Uint8Array), receiver);
    expect(JSON.parse(text(plain))).toEqual({
      title: "Today so far",
      body: "2 missed calls, 0 voicemails, 5 unread texts",
      url: "/recents",
      tag: "digest",
    });
  });

  it("sends once per local day, even when the job runs again", async () => {
    const s = await setup();
    await seedActivity(s.userId, EIGHT_NY);
    const sent = pushService();
    await sendDigests(env, undefined, EIGHT_NY);
    await sendDigests(env, undefined, EIGHT_NY + 15 * 60_000);
    await sendDigests(env, undefined, EIGHT_NY + 6 * HOUR);
    expect(sent).toHaveLength(1);
    // The next local day sends again (new activity since the last digest).
    await addMissed(s.userId, EIGHT_NY + 20 * HOUR);
    await sendDigests(env, undefined, EIGHT_NY + 24 * HOUR);
    expect(sent).toHaveLength(2);
  });

  it("does not run twice at once", async () => {
    const s = await setup();
    await seedActivity(s.userId, EIGHT_NY);
    const sent = pushService();
    await Promise.all([sendDigests(env, undefined, EIGHT_NY), sendDigests(env, undefined, EIGHT_NY)]);
    expect(sent).toHaveLength(1);
  });

  it("sends nothing when every count is zero, but still marks the date", async () => {
    const s = await setup();
    const sent = pushService();
    await sendDigests(env, undefined, EIGHT_NY);
    expect(sent).toEqual([]);
    const row = await env.DB.prepare("SELECT last_digest_date AS d FROM user_preferences WHERE user_id = ?")
      .bind(s.userId)
      .first<{ d: string }>();
    expect(row?.d).toBe("2026-06-10");
    // Activity arriving later the same day waits for tomorrow.
    await seedActivity(s.userId, EIGHT_NY + 2 * HOUR);
    await sendDigests(env, undefined, EIGHT_NY + 3 * HOUR);
    expect(sent).toEqual([]);
  });

  it("sends nothing while the digest is off", async () => {
    const s = await setup();
    await s.json("PUT", "/api/preferences", { digestEnabled: false });
    await seedActivity(s.userId, EIGHT_NY);
    const sent = pushService();
    await sendDigests(env, undefined, EIGHT_NY + HOUR);
    expect(sent).toEqual([]);
  });

  it("uses the owner's zone on a daylight saving day", async () => {
    const s = await setup("America/New_York", "08:00");
    // 2026-03-08: spring forward. 08:00 local is 12:00 UTC.
    const day = Date.parse("2026-03-08T12:00:00Z");
    await seedActivity(s.userId, day);
    const sent = pushService();
    await sendDigests(env, undefined, day - 60_000);
    expect(sent).toEqual([]);
    await sendDigests(env, undefined, day);
    expect(sent).toHaveLength(1);
  });
});

describe("digestCounts", () => {
  it("counts only this owner's missed calls and unread texts since the last digest", async () => {
    const s = await createOwner();
    const db = createDb(env.DB);
    const now = EIGHT_NY;
    // A second owner whose rows must never be counted.
    await env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('other', 'Other', 'other@talvuno.test', 0, 0, 0)",
    ).run();
    const mine = await addNumber(s.userId);
    const theirs = await addNumber("other");

    await addMissed(s.userId, now - HOUR);
    await addMissed(s.userId, now - 2 * HOUR, "busy");
    await addMissed(s.userId, now - 30 * HOUR); // before the window
    await addMissed("other", now - HOUR);
    await addUnread(s.userId, mine, 2);
    await addUnread(s.userId, mine, 3);
    await addUnread("other", theirs, 9);

    expect(await digestCounts(db, s.userId, new Date(now - 24 * HOUR))).toEqual({
      missedCalls: 2,
      voicemails: 0,
      unreadTexts: 5,
    });
  });

  it("does not count answered or outbound calls", async () => {
    const s = await createOwner();
    const db = createDb(env.DB);
    await env.DB.prepare(
      `INSERT INTO calls (id, owner_id, twilio_call_sid, direction, party, status, started_at, answered_at, created_at, updated_at)
       VALUES ('c1', ?, 'CA1', 'inbound', '+1555', 'completed', ?, ?, ?, ?)`,
    )
      .bind(s.userId, EIGHT_NY, EIGHT_NY, EIGHT_NY, EIGHT_NY)
      .run();
    await env.DB.prepare(
      `INSERT INTO calls (id, owner_id, twilio_call_sid, direction, party, status, started_at, created_at, updated_at)
       VALUES ('c2', ?, 'CA2', 'outbound', '+1555', 'no-answer', ?, ?, ?)`,
    )
      .bind(s.userId, EIGHT_NY, EIGHT_NY, EIGHT_NY)
      .run();
    expect((await digestCounts(db, s.userId, new Date(EIGHT_NY - HOUR))).missedCalls).toBe(0);
  });

  it("does not count blocked, voicemail or declined calls as missed", async () => {
    const s = await createOwner();
    const db = createDb(env.DB);
    for (const outcome of [null, "missed", "voicemail", "declined", "blocked"]) {
      await env.DB.prepare(
        `INSERT INTO calls (id, owner_id, twilio_call_sid, direction, party, status, outcome, started_at, created_at, updated_at)
         VALUES (?, ?, ?, 'inbound', '+1555', 'no-answer', ?, ?, ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          s.userId,
          `CA${crypto.randomUUID()}`,
          outcome,
          EIGHT_NY,
          EIGHT_NY,
          EIGHT_NY,
        )
        .run();
    }
    expect((await digestCounts(db, s.userId, new Date(EIGHT_NY - HOUR))).missedCalls).toBe(2);
  });

  it("counts this owner's voicemails since the last digest", async () => {
    const s = await createOwner();
    const db = createDb(env.DB);
    await env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('other', 'Other', 'other@talvuno.test', 0, 0, 0)",
    ).run();
    const add = async (owner: string, at: number) => {
      const callId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO calls (id, owner_id, twilio_call_sid, direction, party, status, outcome, started_at, created_at, updated_at)
         VALUES (?, ?, ?, 'inbound', '+1555', 'no-answer', 'voicemail', ?, ?, ?)`,
      )
        .bind(callId, owner, `CA${crypto.randomUUID()}`, at, at, at)
        .run();
      await env.DB.prepare(
        "INSERT INTO voicemails (id, owner_id, call_id, \"from\", twilio_recording_sid, created_at) VALUES (?, ?, ?, '+1555', ?, ?)",
      )
        .bind(crypto.randomUUID(), owner, callId, `RE${crypto.randomUUID()}`, at)
        .run();
    };
    await add(s.userId, EIGHT_NY - HOUR);
    await add(s.userId, EIGHT_NY - 48 * HOUR);
    await add("other", EIGHT_NY - HOUR);
    const counts = await digestCounts(db, s.userId, new Date(EIGHT_NY - 24 * HOUR));
    expect(counts).toEqual({ missedCalls: 0, voicemails: 1, unreadTexts: 0 });
  });
});

describe("digest preferences API", () => {
  it("defaults to off, saves the fields and rejects bad values", async () => {
    const s: Session = await createOwner();
    expect(await s.get("/api/preferences")).toMatchObject({
      digestEnabled: false,
      digestTime: "08:00",
      timezone: "UTC",
    });
    expect(
      await s.json("PUT", "/api/preferences", {
        digestEnabled: true,
        digestTime: "07:30",
        timezone: "Australia/Sydney",
      }),
    ).toMatchObject({ digestEnabled: true, digestTime: "07:30", timezone: "Australia/Sydney" });
    await s.json("PUT", "/api/preferences", { digestTime: "7:30" }, 400);
    await s.json("PUT", "/api/preferences", { timezone: "Mars/Olympus" }, 400);
  });
});
