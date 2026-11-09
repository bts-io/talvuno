import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { nameSortKey } from "../../src/lib/sort-key";
import { createDb } from "../../src/worker/db";
import { findContactByNumber } from "../../src/worker/lib/contacts";
import { createOwner, resetDb, Session } from "./helpers";

beforeEach(resetDb);

const create = (s: Session, displayName: string, numbers: { number: string; label?: string }[] = []) =>
  s.post("/api/contacts", { displayName, numbers }, 201);

describe("contacts API", () => {
  it("requires a session", async () => {
    await createOwner();
    const anon = new Session();
    for (const path of [
      "/api/contacts",
      "/api/contacts/lookup?number=%2B14155552671",
      "/api/contacts/export",
    ]) {
      expect((await anon.fetch(path)).status, path).toBe(401);
    }
    expect((await anon.fetch("/api/contacts/import", { method: "POST", body: "x" })).status).toBe(401);
    expect((await anon.fetch("/api/calls")).status).toBe(401);
  });

  it("creates with normalized numbers and labels, and reads back", async () => {
    const s = await createOwner();
    const made = await create(s, "Ada Lovelace", [
      { number: "+1 (415) 555-2671", label: "mobile" },
      { number: "0044 20 7946 0958" },
      { number: "+14155552671", label: "dup" },
    ]);
    expect(made.numbers.map((n: any) => [n.e164, n.label])).toEqual([
      ["+14155552671", "mobile"],
      ["+442079460958", null],
    ]);
    const got = await s.get(`/api/contacts/${made.id}`);
    expect(got.displayName).toBe("Ada Lovelace");
    expect(got.numbers).toHaveLength(2);
  });

  it("rejects bad input", async () => {
    const s = await createOwner();
    await s.post("/api/contacts", { displayName: "x", numbers: [{ number: "nope" }] }, 400);
    await s.post("/api/contacts", { displayName: " ", numbers: [] }, 400);
    await s.get("/api/contacts/missing", 404);
  });

  it("refuses a cross-origin write", async () => {
    const s = await createOwner();
    const res = await s.fetch("/api/contacts", {
      method: "POST",
      json: { displayName: "x", numbers: [] },
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
  });

  it("updates by replacing the numbers, and deletes", async () => {
    const s = await createOwner();
    const made = await create(s, "Old", [{ number: "+14155552671" }]);
    const updated = await s.json("PUT", `/api/contacts/${made.id}`, {
      displayName: "New",
      company: "Acme",
      numbers: [{ number: "+442079460958", label: "work" }],
    });
    expect(updated.displayName).toBe("New");
    expect(updated.company).toBe("Acme");
    expect(updated.numbers.map((n: any) => n.e164)).toEqual(["+442079460958"]);
    expect((await s.fetch(`/api/contacts/${made.id}`, { method: "DELETE" })).status).toBe(200);
    await s.get(`/api/contacts/${made.id}`, 404);
    expect((await s.fetch(`/api/contacts/${made.id}`, { method: "DELETE" })).status).toBe(404);
    await s.json("PUT", `/api/contacts/${made.id}`, { displayName: "x", numbers: [] }, 404);
  });

  it("searches by name and by number, and pages by cursor", async () => {
    const s = await createOwner();
    for (let i = 0; i < 5; i++) await create(s, `Person ${i}`, [{ number: `+1415555260${i}` }]);
    await create(s, "zed", [{ number: "+442079460958" }]);
    await create(s, "Édith");

    const p1 = await s.get("/api/contacts?limit=4");
    expect(p1.items.map((c: any) => c.displayName)).toEqual(["Édith", "Person 0", "Person 1", "Person 2"]);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await s.get(`/api/contacts?limit=4&cursor=${encodeURIComponent(p1.nextCursor)}`);
    expect(p2.items.map((c: any) => c.displayName)).toEqual(["Person 3", "Person 4", "zed"]);
    expect(p2.nextCursor).toBeNull();

    expect((await s.get("/api/contacts?q=PERSON%203")).items.map((c: any) => c.displayName)).toEqual([
      "Person 3",
    ]);
    expect((await s.get("/api/contacts?q=2079460")).items.map((c: any) => c.displayName)).toEqual(["zed"]);
    expect((await s.get("/api/contacts?q=%2B1415555260")).items).toHaveLength(5);
    expect((await s.get("/api/contacts?q=nobody")).items).toEqual([]);
    expect((await s.get("/api/contacts?q=%25")).items).toEqual([]);
    await s.get("/api/contacts?cursor=garbage", 400);
  });

  it("pages and searches names with accents and non-ASCII capitals, ignoring both", async () => {
    const s = await createOwner();
    for (const name of ["Émile", "émile", "Zoë", "Adam"]) await create(s, name, [{ number: "+14155552671" }]);
    const names = (r: any) => r.items.map((c: any) => c.displayName);
    const all = names(await s.get("/api/contacts?limit=10"));
    expect(all).toHaveLength(4);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: any = await s.get(
        `/api/contacts?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      seen.push(...names(page));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all);

    // Pages that end exactly between the two accents still continue on the right row.
    const first: any = await s.get("/api/contacts?limit=2");
    const rest: any = await s.get(`/api/contacts?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`);
    expect([...names(first), ...names(rest)]).toEqual(all);

    expect(all[0]).toBe("Adam");
    expect(all.slice(1, 3).sort()).toEqual(["émile", "Émile"].sort());
    expect(all[3]).toBe("Zoë");

    const both = ["Émile", "émile"].sort();
    for (const q of ["Émile", "émile", "EMILE", "mile"]) {
      expect(names(await s.get(`/api/contacts?q=${encodeURIComponent(q)}`)).sort(), q).toEqual(both);
    }
    expect(names(await s.get(`/api/contacts?q=${encodeURIComponent("Zoë")}`))).toEqual(["Zoë"]);
    expect(names(await s.get("/api/contacts?q=zoe"))).toEqual(["Zoë"]);
    expect(names(await s.get("/api/contacts?q=ADAM"))).toEqual(["Adam"]);
  });

  it("orders names the way people expect, through create, rename and paging", async () => {
    const s = await createOwner();
    for (const name of ["Zoë Khan", "sarah Lee", "Émile Dubois", "Ben Ortiz"]) await create(s, name);
    const names = (r: any) => r.items.map((c: any) => c.displayName);
    const expected = ["Ben Ortiz", "Émile Dubois", "sarah Lee", "Zoë Khan"];
    expect(names(await s.get("/api/contacts"))).toEqual(expected);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: any = await s.get(
        `/api/contacts?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      seen.push(...names(page));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(expected);

    // A rename moves the contact to its new place.
    const ben = (await s.get("/api/contacts?q=ben")).items[0];
    await s.json("PUT", `/api/contacts/${ben.id}`, { displayName: "Ánh Tran", numbers: [] });
    expect(names(await s.get("/api/contacts"))).toEqual([
      "Ánh Tran",
      "Émile Dubois",
      "sarah Lee",
      "Zoë Khan",
    ]);
    expect(names(await s.get(`/api/contacts?q=${encodeURIComponent("anh")}`))).toEqual(["Ánh Tran"]);
  });

  it("backfills sort keys for existing rows in the migration the way the API computes them", async () => {
    const { userId } = await createOwner();
    const sample = [
      "Émile",
      "ZOË",
      "Ådne Øvergård",
      "Łukasz Żółć",
      "İlker Şahin",
      "Nguyễn Văn",
      "Straße",
      "Ben",
      "e\u0301clair",
    ];
    const now = Date.now();
    for (const [i, name] of sample.entries()) {
      await env.DB.prepare(
        "INSERT INTO contacts (id, owner_id, display_name, sort_key, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)",
      )
        .bind(`c${i}`, userId, name, now, now)
        .run();
    }
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0003_contact_sort_key"));
    expect(migration).toBeDefined();
    for (const q of migration!.queries.filter((q) => /^\s*UPDATE/i.test(q))) await env.DB.prepare(q).run();
    const { results } = await env.DB.prepare("SELECT display_name, sort_key FROM contacts ORDER BY id").all<{
      display_name: string;
      sort_key: string;
    }>();
    expect(results.map((r) => r.sort_key)).toEqual(sample.map(nameSortKey));
  });

  it("looks a contact up by number, with or without an encoded plus", async () => {
    const s = await createOwner();
    const made = await create(s, "Ada", [{ number: "+14155552671" }]);
    expect((await s.get("/api/contacts/lookup?number=%2B14155552671")).id).toBe(made.id);
    expect((await s.get("/api/contacts/lookup?number=+14155552671")).id).toBe(made.id);
    expect(await s.get("/api/contacts/lookup?number=%2B14155552999")).toBeNull();
    await s.get("/api/contacts/lookup?number=abc", 400);
  });

  it("findContactByNumber is scoped to the owner and picks the first by name", async () => {
    const s = await createOwner();
    await create(s, "beta", [{ number: "+14155552671" }]);
    await create(s, "Alpha", [{ number: "+14155552671" }]);
    const db = createDb(env.DB);
    expect((await findContactByNumber(db, s.userId, "+14155552671"))?.displayName).toBe("Alpha");
    expect(await findContactByNumber(db, "someone-else", "+14155552671")).toBeNull();
    expect(await findContactByNumber(db, s.userId, "+14155550000")).toBeNull();
  });

  it("does not show another owner's contacts", async () => {
    const s = await createOwner();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('u2','Two','two@talvuno.test',0,?,?)",
      ).bind(now, now),
      env.DB.prepare(
        "INSERT INTO contacts (id, owner_id, display_name, created_at, updated_at) VALUES ('c2','u2','Hidden',?,?)",
      ).bind(now, now),
      env.DB.prepare("INSERT INTO contact_numbers (id, contact_id, e164) VALUES ('n2','c2','+14155552671')"),
    ]);
    expect((await s.get("/api/contacts")).items).toEqual([]);
    await s.get("/api/contacts/c2", 404);
    expect(await s.get("/api/contacts/lookup?number=%2B14155552671")).toBeNull();
    expect((await s.fetch("/api/contacts/c2", { method: "DELETE" })).status).toBe(404);
  });
});

describe("vCard import and export", () => {
  const importVcf = async (s: Session, body: string | Uint8Array) => {
    const res = await s.fetch("/api/contacts/import", {
      method: "POST",
      body,
      headers: { "content-type": "text/vcard" },
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  it("round trips an export into a fresh import, then ignores repeats", async () => {
    const s = await createOwner();
    await create(s, "Ada Lovelace", [
      { number: "+14155552671", label: "mobile" },
      { number: "+442079460958", label: "work" },
    ]);
    await create(s, "Zoë, Jr.", [{ number: "+14155552672" }]);

    const res = await s.fetch("/api/contacts/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/vcard");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const vcf = await res.text();
    expect(vcf).toContain("BEGIN:VCARD");

    const again = await importVcf(s, vcf);
    expect(again.body).toEqual({ imported: 0, skipped: 2 });

    await env.DB.prepare("DELETE FROM contacts").run();
    const back = await importVcf(s, vcf);
    expect(back).toEqual({ status: 200, body: { imported: 2, skipped: 0 } });
    const list = await s.get("/api/contacts");
    expect(list.items.map((c: any) => [c.displayName, c.numbers.map((n: any) => [n.e164, n.label])])).toEqual(
      [
        [
          "Ada Lovelace",
          [
            ["+14155552671", "mobile"],
            ["+442079460958", "work"],
          ],
        ],
        ["Zoë, Jr.", [["+14155552672", null]]],
      ],
    );
  });

  it("reports skipped cards", async () => {
    const s = await createOwner();
    const vcf = [
      "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Good\r\nTEL;VALUE=uri:tel:+14155552671\r\nEND:VCARD",
      "BEGIN:VCARD\r\nFN:No number\r\nEND:VCARD",
    ].join("\r\n");
    expect((await importVcf(s, vcf)).body).toEqual({ imported: 1, skipped: 1 });
  });

  it("reads national numbers in the country of the default number", async () => {
    const s = await createOwner();
    const vcf = "BEGIN:VCARD\r\nFN:Local\r\nTEL:(415) 555-2671\r\nEND:VCARD";
    // No default number yet: a national number cannot be placed and the card is skipped.
    expect((await importVcf(s, vcf)).body).toEqual({ imported: 0, skipped: 1 });

    const owner = await env.DB.prepare("SELECT id FROM user LIMIT 1").first<{ id: string }>();
    await env.DB.prepare(
      `INSERT INTO phone_numbers (id, owner_id, e164, twilio_sid, capabilities, is_default, created_at, updated_at)
       VALUES ('n1', ?, '+14155550100', 'PN1', '{"voice":true,"sms":true,"mms":false}', 1, 0, 0)`,
    )
      .bind(owner!.id)
      .run();
    expect((await importVcf(s, vcf)).body).toEqual({ imported: 1, skipped: 0 });
    expect((await s.get("/api/contacts")).items[0].numbers[0].e164).toBe("+14155552671");

    // A released default no longer sets the country.
    await env.DB.prepare("UPDATE phone_numbers SET released_at = 1").run();
    expect((await importVcf(s, "BEGIN:VCARD\r\nFN:Other\r\nTEL:(415) 555-2672\r\nEND:VCARD")).body).toEqual({
      imported: 0,
      skipped: 1,
    });
  });

  it("reads a non-US national number when the default number is in that country", async () => {
    const s = await createOwner();
    const owner = await env.DB.prepare("SELECT id FROM user LIMIT 1").first<{ id: string }>();
    await env.DB.prepare(
      `INSERT INTO phone_numbers (id, owner_id, e164, twilio_sid, capabilities, is_default, created_at, updated_at)
       VALUES ('n2', ?, '+447911123456', 'PN2', '{"voice":true,"sms":true,"mms":false}', 1, 0, 0)`,
    )
      .bind(owner!.id)
      .run();
    const r = await importVcf(s, "BEGIN:VCARD\r\nFN:Ali\r\nTEL:07400 123456\r\nEND:VCARD");
    expect(r.body).toEqual({ imported: 1, skipped: 0 });
    const list = await s.get("/api/contacts");
    expect(list.items.map((c: any) => c.numbers.map((n: any) => n.e164))).toEqual([["+447400123456"]]);
  });

  it("imports at most 500 cards and counts the rest as skipped", async () => {
    const s = await createOwner();
    const vcf = Array.from(
      { length: 520 },
      (_, i) => `BEGIN:VCARD\r\nFN:P${i}\r\nTEL:+1415555${String(1000 + i).padStart(4, "0")}\r\nEND:VCARD`,
    ).join("\r\n");
    expect((await importVcf(s, vcf)).body).toEqual({ imported: 500, skipped: 20 });
  });

  it("refuses files over 1 MB and empty files", async () => {
    const s = await createOwner();
    expect((await importVcf(s, new Uint8Array(1_000_001))).status).toBe(413);
    expect((await importVcf(s, "")).status).toBe(400);
    expect((await s.get("/api/contacts")).items).toEqual([]);
  });
});

describe("calls API", () => {
  type Seed = {
    direction?: string;
    status?: string;
    party?: string;
    startedAt?: number | null;
    contactId?: string | null;
  };
  const seedCall = (ownerId: string, sid: string, over: Seed = {}) =>
    env.DB.prepare(
      `INSERT INTO calls (id, owner_id, twilio_call_sid, direction, party, status, started_at, contact_id, duration, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 12, 500, 500)`,
    )
      .bind(
        sid,
        ownerId,
        sid,
        over.direction ?? "outbound",
        over.party ?? "+14155552671",
        over.status ?? "completed",
        over.startedAt === undefined ? 1000 : over.startedAt,
        over.contactId ?? null,
      )
      .run();

  it("lists newest first with cursor pagination", async () => {
    const s = await createOwner();
    await seedCall(s.userId, "CA1", { startedAt: 1000 });
    await seedCall(s.userId, "CA2", { startedAt: 3000 });
    await seedCall(s.userId, "CA3", { startedAt: 2000 });
    await seedCall(s.userId, "CA4", { startedAt: null });
    const p1 = await s.get("/api/calls?limit=2");
    expect(p1.items.map((c: any) => c.id)).toEqual(["CA2", "CA3"]);
    const p2 = await s.get(`/api/calls?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`);
    expect(p2.items.map((c: any) => c.id)).toEqual(["CA1", "CA4"]);
    expect(p2.nextCursor).toBeNull();
    expect(p1.items[0]).toMatchObject({
      party: "+14155552671",
      duration: 12,
      missed: false,
      contactName: null,
    });
    await s.get("/api/calls?cursor=garbage", 400);
    await s.get("/api/calls?filter=bogus", 400);
  });

  it("filters missed to unanswered inbound calls", async () => {
    const s = await createOwner();
    await seedCall(s.userId, "CA1", { direction: "inbound", status: "no-answer", startedAt: 1 });
    await seedCall(s.userId, "CA2", { direction: "inbound", status: "completed", startedAt: 2 });
    await seedCall(s.userId, "CA3", { direction: "outbound", status: "no-answer", startedAt: 3 });
    await seedCall(s.userId, "CA4", { direction: "inbound", status: "canceled", startedAt: 4 });
    const missed = await s.get("/api/calls?filter=missed");
    expect(missed.items.map((c: any) => c.id)).toEqual(["CA4", "CA1"]);
    expect(missed.items.every((c: any) => c.missed)).toBe(true);
    const all = await s.get("/api/calls");
    expect(all.items.map((c: any) => [c.id, c.missed])).toEqual([
      ["CA4", true],
      ["CA3", false],
      ["CA2", false],
      ["CA1", true],
    ]);
  });

  it("names callers from the linked contact or the contact book", async () => {
    const s = await createOwner();
    await create(s, "Ada", [{ number: "+14155552671" }]);
    const bob = await create(s, "Bob", [{ number: "+14155552672" }]);
    await seedCall(s.userId, "CA1", { party: "+14155552671", startedAt: 1, contactId: bob.id });
    await seedCall(s.userId, "CA2", { party: "+14155552671", startedAt: 2 });
    await seedCall(s.userId, "CA3", { party: "+14155550000", startedAt: 3 });
    const names = (await s.get("/api/calls")).items.map((c: any) => [c.id, c.contactName]);
    expect(names).toEqual([
      ["CA3", null],
      ["CA2", "Ada"],
      ["CA1", "Bob"],
    ]);
  });

  it("is read only", async () => {
    const s = await createOwner();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((await s.fetch("/api/calls", { method, json: {} })).status, method).toBe(404);
    }
  });
});
