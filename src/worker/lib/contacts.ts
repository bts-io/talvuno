/** Contact queries shared by the contacts API and, through `findContactByNumber`, the voice and SMS handlers. */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Contact } from "../../contracts";
import { type Db, schema } from "../db";
import { ApiError } from "./errors";

const { contacts, contactNumbers } = schema;

type ContactRow = typeof contacts.$inferSelect;

export function toContact(row: ContactRow, numbers: (typeof contactNumbers.$inferSelect)[]): Contact {
  return {
    id: row.id,
    displayName: row.displayName,
    company: row.company,
    notes: row.notes,
    numbers: numbers.map((n) => ({ id: n.id, e164: n.e164, label: n.label })),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** Loads the numbers for a page of contacts in one query, in the order they were added. */
export async function withNumbers(db: Db, rows: ContactRow[]): Promise<Contact[]> {
  if (rows.length === 0) return [];
  const numbers = await db
    .select()
    .from(contactNumbers)
    .where(
      inArray(
        contactNumbers.contactId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(sql`rowid`);
  const byContact = new Map<string, (typeof numbers)[number][]>();
  for (const n of numbers) byContact.set(n.contactId, [...(byContact.get(n.contactId) ?? []), n]);
  return rows.map((r) => toContact(r, byContact.get(r.id) ?? []));
}

export async function getContact(db: Db, ownerId: string, id: string): Promise<Contact | null> {
  const [row] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.ownerId, ownerId), eq(contacts.id, id)));
  if (!row) return null;
  return (await withNumbers(db, [row]))[0] ?? null;
}

/**
 * The owner's contact that has `e164` among its numbers, or null. When several contacts share a number the
 * first by name wins, so the answer is stable. Voice and SMS call this to name a caller or sender.
 */
export async function findContactByNumber(db: Db, ownerId: string, e164: string): Promise<Contact | null> {
  const [row] = await db
    .select({ contact: contacts })
    .from(contactNumbers)
    .innerJoin(contacts, eq(contacts.id, contactNumbers.contactId))
    .where(and(eq(contacts.ownerId, ownerId), eq(contactNumbers.e164, e164)))
    .orderBy(asc(contacts.sortKey), asc(contacts.id))
    .limit(1);
  if (!row) return null;
  return (await withNumbers(db, [row.contact]))[0] ?? null;
}

export type NumberInput = { number: string; label?: string | null | undefined };

/** Drops repeated numbers (a contact may hold each E.164 once) and turns empty labels into null. */
export function dedupeNumbers(numbers: readonly NumberInput[]): { e164: string; label: string | null }[] {
  const seen = new Set<string>();
  const out: { e164: string; label: string | null }[] = [];
  for (const n of numbers) {
    if (seen.has(n.number)) continue;
    seen.add(n.number);
    out.push({ e164: n.number, label: n.label?.trim() || null });
  }
  return out;
}

export function encodeCursor(parts: readonly (string | number)[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeCursor(cursor: string, shape: readonly ("string" | "number")[]): (string | number)[] {
  try {
    const padded = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const parts: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0))),
    );
    if (
      Array.isArray(parts) &&
      parts.length === shape.length &&
      parts.every((p, i) => typeof p === shape[i])
    ) {
      return parts as (string | number)[];
    }
  } catch {
    // fall through
  }
  throw new ApiError(400, "invalid_cursor", "The cursor is not valid");
}
