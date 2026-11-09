import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Hono } from "hono";
import { z } from "zod";
import { contactInputSchema, idSchema } from "../../contracts";
import {
  type ContactList,
  contactListQuerySchema,
  contactLookupQuerySchema,
  VCARD_MAX_BYTES,
  type VcardImportResult,
} from "../../contracts/contacts";
import { countryOf, toE164 } from "../../lib/phone";
import { nameSortKey } from "../../lib/sort-key";
import { parseVcf, serializeVcf, type VcardContact } from "../../lib/vcard";
import { type Db, schema } from "../db";
import {
  decodeCursor,
  dedupeNumbers,
  encodeCursor,
  findContactByNumber,
  getContact,
  type NumberInput,
  withNumbers,
} from "../lib/contacts";
import { ApiError } from "../lib/errors";
import { validationHook } from "../lib/validation";
import type { AppEnv } from "../types";

const { contacts, contactNumbers, phoneNumbers } = schema;

/** Contacts CRUD, lookup by number, and vCard import and export. Mounted at /api/contacts. */
export const contactsRouter = new Hono<AppEnv>();

type Batch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

/** Rows written per D1 batch during an import. Each contact is two statements. */
const IMPORT_CHUNK = 50;
const IMPORT_MAX_CARDS = 500;

function numberInserts(db: Db, contactId: string, numbers: readonly NumberInput[]) {
  const rows = dedupeNumbers(numbers).map((n) => ({ contactId, e164: n.e164, label: n.label }));
  return rows.length ? [db.insert(contactNumbers).values(rows)] : [];
}

contactsRouter.get("/", zValidator("query", contactListQuerySchema, validationHook), async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const { q, cursor, limit } = c.req.valid("query");

  const conds = [eq(contacts.ownerId, ownerId)];
  if (q) {
    const digits = q.replace(/\D/g, "");
    const byName = sql`instr(${contacts.sortKey}, ${nameSortKey(q)}) > 0`;
    const byNumber =
      digits.length >= 3
        ? sql`exists (select 1 from ${contactNumbers} where ${contactNumbers.contactId} = ${contacts.id} and instr(${contactNumbers.e164}, ${digits}) > 0)`
        : undefined;
    conds.push((byNumber ? or(byName, byNumber) : byName) as (typeof conds)[number]);
  }
  if (cursor) {
    const [name, id] = decodeCursor(cursor, ["string", "string"]) as [string, string];
    conds.push(
      or(
        gt(contacts.sortKey, name),
        and(eq(contacts.sortKey, name), gt(contacts.id, id)),
      ) as (typeof conds)[number],
    );
  }

  // Ordered by the stored sort key, so "Émile" sits between Ben and Sarah. The cursor carries that key.
  const rows = await db
    .select()
    .from(contacts)
    .where(and(...conds))
    .orderBy(asc(contacts.sortKey), asc(contacts.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const body: ContactList = {
    items: await withNumbers(db, page),
    nextCursor: rows.length > limit && last ? encodeCursor([last.sortKey, last.id]) : null,
  };
  return c.json(body);
});

contactsRouter.get("/lookup", zValidator("query", contactLookupQuerySchema, validationHook), async (c) => {
  // An unencoded "+" in a query string arrives as a space, so a leading space means a leading plus.
  const raw = c.req.valid("query").number;
  const e164 = toE164(raw.startsWith(" ") ? `+${raw.trim()}` : raw);
  if (!e164) throw new ApiError(400, "invalid", "Not a valid phone number");
  return c.json(await findContactByNumber(c.get("db"), c.get("user")!.id, e164));
});

contactsRouter.get("/export", async (c) => {
  const db = c.get("db");
  const rows = await db
    .select()
    .from(contacts)
    .where(eq(contacts.ownerId, c.get("user")!.id))
    .orderBy(asc(contacts.sortKey), asc(contacts.id));
  const all: VcardContact[] = [];
  // Numbers are read in slices so the IN list stays under D1's bound-parameter limit.
  for (let i = 0; i < rows.length; i += 50) {
    for (const contact of await withNumbers(db, rows.slice(i, i + 50))) {
      all.push({
        displayName: contact.displayName,
        company: contact.company,
        notes: contact.notes,
        numbers: contact.numbers.map((n) => ({ number: n.e164, label: n.label })),
      });
    }
  }
  return new Response(serializeVcf(all), {
    headers: {
      "content-type": "text/vcard; charset=utf-8",
      "content-disposition": 'attachment; filename="talvuno-contacts.vcf"',
      "cache-control": "no-store",
    },
  });
});

contactsRouter.post("/import", async (c) => {
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > VCARD_MAX_BYTES) throw new ApiError(413, "too_large", "The file is larger than 1 MB");
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength > VCARD_MAX_BYTES)
    throw new ApiError(413, "too_large", "The file is larger than 1 MB");
  if (bytes.byteLength === 0) throw new ApiError(400, "invalid", "The file is empty");

  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  // National-format numbers are read in the country of the owner's default number, if there is one.
  const [defaultNumber] = await db
    .select({ e164: phoneNumbers.e164 })
    .from(phoneNumbers)
    .where(
      and(
        eq(phoneNumbers.ownerId, ownerId),
        eq(phoneNumbers.isDefault, true),
        isNull(phoneNumbers.releasedAt),
      ),
    )
    .limit(1);
  const country = (defaultNumber && countryOf(defaultNumber.e164)) || undefined;
  const parsed = parseVcf(new TextDecoder().decode(bytes), country, IMPORT_MAX_CARDS);
  let skipped = parsed.skipped;
  const cards = parsed.contacts;

  // A card whose name and a number match an existing contact is a repeat of an earlier import.
  const existing = await db
    .select({ name: contacts.displayName, e164: contactNumbers.e164 })
    .from(contactNumbers)
    .innerJoin(contacts, eq(contacts.id, contactNumbers.contactId))
    .where(eq(contacts.ownerId, ownerId));
  const known = new Set(existing.map((r) => `${r.name.toLowerCase()}\n${r.e164}`));

  const fresh: VcardContact[] = [];
  for (const card of cards) {
    const keys = card.numbers.map((n) => `${card.displayName.toLowerCase()}\n${n.number}`);
    if (keys.some((k) => known.has(k))) {
      skipped++;
      continue;
    }
    for (const k of keys) known.add(k);
    fresh.push(card);
  }

  for (let i = 0; i < fresh.length; i += IMPORT_CHUNK) {
    const statements: BatchItem<"sqlite">[] = [];
    for (const card of fresh.slice(i, i + IMPORT_CHUNK)) {
      const id = crypto.randomUUID();
      statements.push(
        db.insert(contacts).values({
          id,
          ownerId,
          displayName: card.displayName,
          sortKey: nameSortKey(card.displayName),
          company: card.company,
          notes: card.notes,
        }),
        ...numberInserts(
          db,
          id,
          card.numbers.map((n) => ({ number: n.number, label: n.label })),
        ),
      );
    }
    await db.batch(statements as Batch);
  }
  return c.json({ imported: fresh.length, skipped } satisfies VcardImportResult);
});

contactsRouter.get("/:id", zValidator("param", z.object({ id: idSchema }), validationHook), async (c) => {
  const contact = await getContact(c.get("db"), c.get("user")!.id, c.req.valid("param").id);
  if (!contact) throw new ApiError(404, "not_found", "Contact not found");
  return c.json(contact);
});

contactsRouter.post("/", zValidator("json", contactInputSchema, validationHook), async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const input = c.req.valid("json");
  const id = crypto.randomUUID();
  await db.batch([
    db.insert(contacts).values({
      id,
      ownerId,
      displayName: input.displayName,
      sortKey: nameSortKey(input.displayName),
      company: input.company?.trim() || null,
      notes: input.notes?.trim() || null,
    }),
    ...numberInserts(db, id, input.numbers),
  ] as Batch);
  return c.json(await getContact(db, ownerId, id), 201);
});

contactsRouter.put(
  "/:id",
  zValidator("param", z.object({ id: idSchema }), validationHook),
  zValidator("json", contactInputSchema, validationHook),
  async (c) => {
    const db = c.get("db");
    const ownerId = c.get("user")!.id;
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    if (!(await getContact(db, ownerId, id))) throw new ApiError(404, "not_found", "Contact not found");
    await db.batch([
      db
        .update(contacts)
        .set({
          displayName: input.displayName,
          sortKey: nameSortKey(input.displayName),
          company: input.company?.trim() || null,
          notes: input.notes?.trim() || null,
        })
        .where(and(eq(contacts.id, id), eq(contacts.ownerId, ownerId))),
      db.delete(contactNumbers).where(eq(contactNumbers.contactId, id)),
      ...numberInserts(db, id, input.numbers),
    ] as Batch);
    return c.json(await getContact(db, ownerId, id));
  },
);

contactsRouter.delete("/:id", zValidator("param", z.object({ id: idSchema }), validationHook), async (c) => {
  const { id } = c.req.valid("param");
  const deleted = await c
    .get("db")
    .delete(contacts)
    .where(and(eq(contacts.id, id), eq(contacts.ownerId, c.get("user")!.id)))
    .returning({ id: contacts.id });
  if (deleted.length === 0) throw new ApiError(404, "not_found", "Contact not found");
  return c.json({ deleted: true });
});
