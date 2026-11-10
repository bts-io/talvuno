import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createOwner, resetDb, Session } from "./helpers";

beforeEach(resetDb);

const ZONE = "Australia/Sydney"; // UTC+10 in June
const T = (iso: string) => Date.parse(iso);
const OURS = "+14155550100";

async function owner(timezone = ZONE) {
  const s = await createOwner();
  await s.json("PUT", "/api/preferences", { timezone });
  const numberId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO phone_numbers (id, owner_id, e164, twilio_sid, capabilities, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, '{"voice":true,"sms":true,"mms":false}', 0, 0, 0)`,
  )
    .bind(numberId, s.userId, OURS, `PN${numberId}`)
    .run();
  return { s, numberId };
}

async function call(
  ownerId: string,
  numberId: string | null,
  at: number,
  o: {
    direction?: "inbound" | "outbound";
    status?: string;
    outcome?: string | null;
    answered?: boolean;
    duration?: number | null;
    party?: string;
  } = {},
) {
  await env.DB.prepare(
    `INSERT INTO calls (id, owner_id, twilio_call_sid, direction, number_id, party, status, outcome, started_at, answered_at, duration, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      ownerId,
      `CA${crypto.randomUUID()}`,
      o.direction ?? "inbound",
      numberId,
      o.party ?? "+14155551111",
      o.status ?? "no-answer",
      o.outcome ?? null,
      at,
      o.answered ? at : null,
      o.duration ?? null,
      at,
      at,
    )
    .run();
}

async function text(
  ownerId: string,
  numberId: string,
  at: number,
  direction: "inbound" | "outbound",
  o: { body?: string; status?: string; party?: string } = {},
) {
  const party = o.party ?? "+14155552222";
  const conv =
    (await env.DB.prepare(
      "SELECT id FROM conversations WHERE owner_id = ? AND number_id = ? AND participant = ?",
    )
      .bind(ownerId, numberId, party)
      .first<{ id: string }>()) ?? null;
  const convId = conv?.id ?? crypto.randomUUID();
  if (!conv)
    await env.DB.prepare(
      "INSERT INTO conversations (id, owner_id, number_id, participant, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)",
    )
      .bind(convId, ownerId, numberId, party)
      .run();
  await env.DB.prepare(
    `INSERT INTO messages (id, owner_id, conversation_id, direction, "from", "to", body, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      ownerId,
      convId,
      direction,
      direction === "inbound" ? party : OURS,
      direction === "inbound" ? OURS : party,
      o.body ?? "hi",
      o.status ?? (direction === "inbound" ? "received" : "delivered"),
      at,
      at,
    )
    .run();
}

async function voicemail(ownerId: string, numberId: string, at: number, from = "+14155551111") {
  const callId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO calls (id, owner_id, twilio_call_sid, direction, number_id, party, status, outcome, started_at, created_at, updated_at)
     VALUES (?, ?, ?, 'inbound', ?, ?, 'completed', 'voicemail', ?, ?, ?)`,
  )
    .bind(callId, ownerId, `CA${callId}`, numberId, from, at, at, at)
    .run();
  await env.DB.prepare(
    `INSERT INTO voicemails (id, owner_id, call_id, number_id, "from", twilio_recording_sid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), ownerId, callId, numberId, from, `RE${callId}`, at)
    .run();
}

const stats = (s: Session, qs: string) => s.get(`/api/stats?${qs}`);

describe("GET /api/stats", () => {
  it("counts calls, missed rate, average length, texts and voicemails per local day", async () => {
    const { s, numberId } = await owner();
    const id = s.userId;
    // 2026-06-10 in Sydney
    await call(id, numberId, T("2026-06-10T01:00:00Z")); // missed
    await call(id, numberId, T("2026-06-10T02:00:00Z"), {
      status: "completed",
      answered: true,
      duration: 60,
    });
    await call(id, numberId, T("2026-06-10T03:00:00Z"), {
      direction: "outbound",
      status: "completed",
      answered: true,
      duration: 120,
    });
    await call(id, numberId, T("2026-06-10T03:30:00Z"), { direction: "outbound", status: "no-answer" });
    await text(id, numberId, T("2026-06-10T04:00:00Z"), "outbound");
    await text(id, numberId, T("2026-06-10T04:05:00Z"), "inbound");
    await text(id, numberId, T("2026-06-10T04:06:00Z"), "outbound", { status: "failed" });
    await voicemail(id, numberId, T("2026-06-10T05:00:00Z"));

    const r = await stats(s, "from=2026-06-10&to=2026-06-10");
    expect(r.range).toMatchObject({ from: "2026-06-10", to: "2026-06-10", timeZone: ZONE, days: 1 });
    expect(r.days).toHaveLength(1);
    expect(r.days[0]).toMatchObject({
      date: "2026-06-10",
      callsInbound: 3, // missed, answered and the voicemail call
      callsOutbound: 2,
      missed: 1, // the voicemail call is not missed, and neither is an unanswered outbound call
      textsSent: 1, // the failed text never left
      textsReceived: 1,
      voicemails: 1,
    });
    expect(r.totals.missedRate).toBeCloseTo(1 / 3);
    expect(r.totals.avgAnsweredSeconds).toBe(90);
    expect(r.totals.answered).toBe(2);
  });

  it("does not count voicemail, declined or blocked outcomes as missed", async () => {
    const { s, numberId } = await owner();
    const at = T("2026-06-10T01:00:00Z");
    for (const outcome of ["voicemail", "declined", "blocked", "missed", null])
      await call(s.userId, numberId, at, { status: "no-answer", outcome });
    const r = await stats(s, "from=2026-06-10&to=2026-06-10");
    expect(r.totals.callsInbound).toBe(5);
    expect(r.totals.missed).toBe(2);
    // Blocked calls leave the rate's total, declined ones stay in as handled.
    expect(r.totals.callsInboundRated).toBe(4);
    expect(r.totals.missedRate).toBeCloseTo(2 / 4);
    // The list's own rule agrees.
    const missedList = await s.get("/api/calls?filter=missed");
    expect(missedList.items).toHaveLength(r.totals.missed);
  });

  it("puts a call on the owner's local day, not the UTC day", async () => {
    const { s, numberId } = await owner();
    await call(s.userId, numberId, T("2026-06-09T13:30:00Z")); // 23:30 on the 9th in Sydney
    await call(s.userId, numberId, T("2026-06-09T14:30:00Z")); // 00:30 on the 10th
    const r = await stats(s, "from=2026-06-09&to=2026-06-10");
    expect(r.days.map((d: { date: string; callsInbound: number }) => [d.date, d.callsInbound])).toEqual([
      ["2026-06-09", 1],
      ["2026-06-10", 1],
    ]);
    // The same instants in UTC both fall on the 9th and the 10th differently.
    await s.json("PUT", "/api/preferences", { timezone: "UTC" });
    const utc = await stats(s, "from=2026-06-09&to=2026-06-10");
    expect(utc.days.map((d: { callsInbound: number }) => d.callsInbound)).toEqual([2, 0]);
  });

  it("handles a half-hour zone and a day change in daylight saving", async () => {
    const { s, numberId } = await owner("Asia/Kolkata"); // UTC+5:30
    await call(s.userId, numberId, T("2026-06-09T18:20:00Z")); // 23:50 on the 9th
    await call(s.userId, numberId, T("2026-06-09T18:40:00Z")); // 00:10 on the 10th
    const r = await stats(s, "from=2026-06-09&to=2026-06-10");
    expect(r.days.map((d: { callsInbound: number }) => d.callsInbound)).toEqual([1, 1]);

    await s.json("PUT", "/api/preferences", { timezone: "America/New_York" });
    // 2026-03-08 is 23 hours long in New York.
    await call(s.userId, numberId, T("2026-03-09T03:59:00Z")); // 23:59 EDT on the 8th
    await call(s.userId, numberId, T("2026-03-09T04:00:00Z")); // 00:00 EDT on the 9th
    const dst = await stats(s, "from=2026-03-08&to=2026-03-09");
    expect(dst.days.map((d: { callsInbound: number }) => d.callsInbound)).toEqual([1, 1]);
  });

  it("answers an empty range with zeros and null rates, never NaN", async () => {
    const { s } = await owner();
    const r = await stats(s, "from=2026-06-01&to=2026-06-03");
    expect(r.days).toHaveLength(3);
    expect(r.totals).toMatchObject({
      calls: 0,
      missed: 0,
      callsInboundRated: 0,
      missedRate: null,
      avgAnsweredSeconds: null,
      textsSent: 0,
      textsReceived: 0,
      voicemails: 0,
    });
    expect(r.topContacts).toEqual([]);
  });

  it("ranks the top five contacts by calls, texts and voicemails, with names", async () => {
    const { s, numberId } = await owner();
    const id = s.userId;
    const at = T("2026-06-10T01:00:00Z");
    await s.post("/api/contacts", { displayName: "Ada", numbers: [{ number: "+14155550001" }] }, 201);
    for (let i = 0; i < 3; i++) await call(id, numberId, at + i, { party: "+14155550001" });
    await text(id, numberId, at, "inbound", { party: "+14155550001" });
    for (let p = 2; p <= 7; p++) await call(id, numberId, at, { party: `+1415555000${p}` });
    await call(id, numberId, at, { party: "+14155550007" });
    const r = await stats(s, "from=2026-06-10&to=2026-06-10");
    expect(r.topContacts).toHaveLength(5);
    expect(r.topContacts[0]).toMatchObject({
      party: "+14155550001",
      name: "Ada",
      calls: 3,
      texts: 1,
      total: 4,
    });
    expect(r.topContacts[1]).toMatchObject({ party: "+14155550007", total: 2 });
  });

  it("filters by number and never reads another owner's rows", async () => {
    const { s, numberId } = await owner();
    const second = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO phone_numbers (id, owner_id, e164, twilio_sid, capabilities, is_default, created_at, updated_at)
       VALUES (?, ?, '+14155550199', 'PN2', '{"voice":true,"sms":true,"mms":false}', 0, 0, 0)`,
    )
      .bind(second, s.userId)
      .run();
    const at = T("2026-06-10T01:00:00Z");
    await call(s.userId, numberId, at);
    await call(s.userId, second, at);
    await call(s.userId, second, at);
    await text(s.userId, second, at, "outbound");

    expect((await stats(s, `from=2026-06-10&to=2026-06-10&numberId=${numberId}`)).totals.callsInbound).toBe(
      1,
    );
    const two = await stats(s, `from=2026-06-10&to=2026-06-10&numberId=${second}`);
    expect(two.totals).toMatchObject({ callsInbound: 2, textsSent: 1 });

    await env.DB.prepare(
      "INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('other', 'Other', 'other@talvuno.test', 0, 0)",
    ).run();
    await call("other", null, at);
    expect((await stats(s, "from=2026-06-10&to=2026-06-10")).totals.callsInbound).toBe(3);
    // Another owner's number id gives nothing.
    expect((await stats(s, "from=2026-06-10&to=2026-06-10&numberId=nope")).totals.calls).toBe(0);
  });

  it("caps the range at 366 days and rejects bad dates", async () => {
    const { s } = await owner();
    expect((await stats(s, "from=2025-06-10&to=2026-06-10")).days).toHaveLength(366);
    const long = await s.fetch("/api/stats?from=2025-06-09&to=2026-06-10");
    expect(long.status).toBe(400);
    expect(await long.json()).toMatchObject({ error: "range_too_long" });
    expect((await s.fetch("/api/stats?from=2026-06-10&to=2026-06-01")).status).toBe(400);
    expect((await s.fetch("/api/stats?from=2026-02-31&to=2026-03-01")).status).toBe(400);
    expect((await s.fetch("/api/stats?from=yesterday")).status).toBe(400);
  });

  it("needs a signed-in owner", async () => {
    await createOwner();
    expect((await new Session().fetch("/api/stats")).status).toBe(401);
    expect((await new Session().fetch("/api/export/calls.csv")).status).toBe(401);
  });
});

describe("CSV export", () => {
  it("exports calls with attachment headers and ISO times in the owner's zone", async () => {
    const { s, numberId } = await owner();
    await call(s.userId, numberId, T("2026-06-10T01:00:00Z"), {
      status: "completed",
      answered: true,
      duration: 75,
    });
    await call(s.userId, numberId, T("2026-06-10T02:00:00Z"));
    await call(s.userId, numberId, T("2026-07-10T02:00:00Z")); // out of range
    const res = await s.fetch("/api/export/calls.csv?from=2026-06-10&to=2026-06-10");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="talvuno-calls-2026-06-10_2026-06-10.csv"',
    );
    const lines = (await res.text()).trimEnd().split("\r\n");
    expect(lines[0]).toBe("time,direction,number,party,status,outcome,missed,duration_seconds");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(`2026-06-10T11:00:00+10:00,inbound,${OURS},+14155551111,completed,,false,75`);
    expect(lines[2]).toContain(",no-answer,,true,");
  });

  it("escapes quotes, commas and newlines and defuses formulas in message bodies", async () => {
    const { s, numberId } = await owner();
    const at = T("2026-06-10T01:00:00Z");
    const bodies = [
      'say "hi", ok',
      "line one\nline two",
      '=HYPERLINK("http://x")',
      "+1 call me",
      "-5",
      "@cmd",
      "plain",
    ];
    for (const [i, body] of bodies.entries()) await text(s.userId, numberId, at + i, "inbound", { body });
    const out = await (await s.fetch("/api/export/messages.csv?from=2026-06-10&to=2026-06-10")).text();
    expect(out).toContain('"say ""hi"", ok"');
    expect(out).toContain('"line one\nline two"');
    expect(out).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(out).toContain("'+1 call me");
    expect(out).toContain("'-5");
    expect(out).toContain("'@cmd");
    expect(out).toContain(",plain\r\n");
    // A real E.164 party stays usable.
    expect(out).toContain(",+14155552222,");
  });

  it("neutralises a formula in a caller id", async () => {
    const { s, numberId } = await owner();
    await call(s.userId, numberId, T("2026-06-10T01:00:00Z"), { party: "=1+1" });
    const out = await (await s.fetch("/api/export/calls.csv?from=2026-06-10&to=2026-06-10")).text();
    expect(out).toContain(",'=1+1,");
  });

  it("streams more than one page in order, filters by number, and scopes to the owner", async () => {
    const { s, numberId } = await owner();
    const base = T("2026-06-10T01:00:00Z");
    for (let i = 0; i < 520; i++)
      await call(s.userId, numberId, base + i * 1000, { party: `+1415555${String(i).padStart(4, "0")}` });
    await env.DB.prepare(
      "INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('other', 'Other', 'other@talvuno.test', 0, 0)",
    ).run();
    await call("other", null, base);
    const out = await (
      await s.fetch(`/api/export/calls.csv?from=2026-06-10&to=2026-06-10&numberId=${numberId}`)
    ).text();
    const lines = out.trimEnd().split("\r\n");
    expect(lines).toHaveLength(521);
    const times = lines.slice(1).map((l) => l.split(",")[0]!);
    expect(times).toEqual([...times].sort());
    expect(new Set(times).size).toBe(520);
    const none = await (
      await s.fetch("/api/export/calls.csv?from=2026-06-10&to=2026-06-10&numberId=nope")
    ).text();
    expect(none.trimEnd().split("\r\n")).toHaveLength(1);
  });

  it("applies the same range cap", async () => {
    const { s } = await owner();
    expect((await s.fetch("/api/export/calls.csv?from=2025-01-01&to=2026-06-10")).status).toBe(400);
    expect((await s.fetch("/api/export/messages.csv?from=2025-01-01&to=2026-06-10")).status).toBe(400);
  });
});
