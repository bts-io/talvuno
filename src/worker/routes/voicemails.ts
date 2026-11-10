/**
 * The owner's voicemail. Mounted at /api/voicemails, behind the owner session like every /api route.
 *
 *   GET    /                  newest first, cursor paginated, `q` matches the transcript or the number
 *   GET    /settings          retention
 *   PUT    /settings
 *   GET    /:id/audio         the audio from R2, with Range support so the player can seek
 *   POST   /:id/listened      marks it heard
 *   POST   /:id/transcribe    queues a failed transcript again
 *   DELETE /:id               deletes the audio and the row
 */
import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  type Voicemail,
  type VoicemailList,
  type VoicemailSettings,
  voicemailListQuerySchema,
  voicemailSettingsSchema,
} from "../../contracts/voicemail";
import { schema } from "../db";
import { decodeCursor, encodeCursor } from "../lib/contacts";
import { ApiError } from "../lib/errors";
import { notifyOwner } from "../lib/hub";
import { validationHook } from "../lib/validation";
import { deleteVoicemail, retentionDays, retryTranscription } from "../lib/voicemail";
import type { AppEnv } from "../types";

const { voicemails, voicemailSettings } = schema;

export const voicemailsRouter = new Hono<AppEnv>();

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

voicemailsRouter.get("/", zValidator("query", voicemailListQuerySchema, validationHook), async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const { q, cursor, limit } = c.req.valid("query");
  c.header("cache-control", "no-store");

  const conds = [eq(voicemails.ownerId, ownerId)];
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    conds.push(
      or(
        sql`${voicemails.transcript} like ${pattern} escape '\\'`,
        sql`${voicemails.from} like ${pattern} escape '\\'`,
      ) as (typeof conds)[number],
    );
  }
  if (cursor) {
    const [at, id] = decodeCursor(cursor, ["number", "string"]) as [number, string];
    conds.push(
      or(
        lt(voicemails.createdAt, new Date(at)),
        and(eq(voicemails.createdAt, new Date(at)), lt(voicemails.id, id)),
      ) as (typeof conds)[number],
    );
  }

  // Written with table names because a single-table select leaves Drizzle's columns unqualified.
  const name = sql<string | null>`(
    select c.display_name from contact_numbers n
    inner join contacts c on c.id = n.contact_id
    where n.e164 = "voicemails"."from" and c.owner_id = "voicemails"."owner_id"
    order by c.sort_key, c.id limit 1)`;

  const rows = await db
    .select({ vm: voicemails, contactName: name })
    .from(voicemails)
    .where(and(...conds))
    .orderBy(desc(voicemails.createdAt), desc(voicemails.id))
    .limit(limit + 1);
  const unheard = await db
    .select({ n: count() })
    .from(voicemails)
    .where(and(eq(voicemails.ownerId, ownerId), isNull(voicemails.listenedAt)))
    .get();

  const page = rows.slice(0, limit);
  const items: Voicemail[] = page.map(({ vm, contactName }) => ({
    id: vm.id,
    callId: vm.callId,
    numberId: vm.numberId,
    from: vm.from,
    contactName: contactName ?? null,
    duration: vm.duration,
    audioReady: Boolean(vm.r2Key),
    transcript: vm.transcript,
    transcriptStatus: vm.transcriptStatus,
    createdAt: vm.createdAt.getTime(),
    listenedAt: vm.listenedAt?.getTime() ?? null,
  }));
  const last = page.at(-1)?.vm;
  const body: VoicemailList = {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor([last.createdAt.getTime(), last.id]) : null,
    unheard: unheard?.n ?? 0,
  };
  return c.json(body);
});

voicemailsRouter.get("/settings", async (c) => {
  c.header("cache-control", "no-store");
  const body: VoicemailSettings = { retentionDays: await retentionDays(c.get("db"), c.get("user")!.id) };
  return c.json(body);
});

voicemailsRouter.put("/settings", zValidator("json", voicemailSettingsSchema, validationHook), async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const { retentionDays: days } = c.req.valid("json");
  await db
    .insert(voicemailSettings)
    .values({ ownerId, retentionDays: days })
    .onConflictDoUpdate({
      target: voicemailSettings.ownerId,
      set: { retentionDays: days, updatedAt: new Date() },
    });
  const body: VoicemailSettings = { retentionDays: days };
  return c.json(body);
});

/** The voicemail named by `:id`, if it belongs to the signed-in owner. Anyone else's is a 404. */
async function ownVoicemail(c: Context<AppEnv>) {
  const row = await c
    .get("db")
    .select()
    .from(voicemails)
    .where(and(eq(voicemails.id, c.req.param("id") ?? ""), eq(voicemails.ownerId, c.get("user")!.id)))
    .get();
  if (!row) throw new ApiError(404, "not_found", "Voicemail not found");
  return row;
}

type Range = { offset: number; length: number };

/**
 * One byte range from a Range header against an object of `size` bytes. Null means serve the whole object,
 * "unsatisfiable" means 416. Only single ranges are supported; a multi-range request gets the whole object.
 */
export function parseRange(header: string | undefined, size: number): Range | null | "unsatisfiable" {
  const m = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const [, a, b] = m;
  if (!a && !b) return null;
  if (!a) {
    const suffix = Number(b);
    if (suffix === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(a);
  if (start >= size) return "unsatisfiable";
  const end = b ? Math.min(Number(b), size - 1) : size - 1;
  if (end < start) return "unsatisfiable";
  return { offset: start, length: end - start + 1 };
}

voicemailsRouter.get("/:id/audio", async (c) => {
  const row = await ownVoicemail(c);
  if (!row.r2Key) throw new ApiError(409, "not_ready", "The audio is not stored yet");
  const head = await c.env.RECORDINGS.head(row.r2Key);
  if (!head) throw new ApiError(404, "not_found", "Audio not found");
  const size = head.size;
  const range = parseRange(c.req.header("range"), size);
  const headers = new Headers({
    "content-type": row.contentType ?? head.httpMetadata?.contentType ?? "audio/mpeg",
    "cache-control": "private, no-store",
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
  });
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const object = await c.env.RECORDINGS.get(row.r2Key, range ? { range } : {});
  if (!object) throw new ApiError(404, "not_found", "Audio not found");
  if (range) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
    headers.set("content-length", String(range.length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("content-length", String(size));
  return new Response(object.body, { status: 200, headers });
});

voicemailsRouter.post("/:id/listened", async (c) => {
  const row = await ownVoicemail(c);
  if (!row.listenedAt) {
    await c
      .get("db")
      .update(voicemails)
      .set({ listenedAt: new Date() })
      .where(and(eq(voicemails.id, row.id), isNull(voicemails.listenedAt)));
    await notifyOwner(c.env, row.ownerId, { type: "voicemail", voicemailId: row.id }, c.executionCtx);
  }
  return c.body(null, 204);
});

voicemailsRouter.post("/:id/transcribe", async (c) => {
  const row = await ownVoicemail(c);
  if (row.transcriptStatus !== "failed")
    throw new ApiError(409, "not_failed", "Only a failed transcript can be retried");
  if (!(await retryTranscription(c.env, c.get("db"), row)))
    throw new ApiError(409, "not_ready", "The audio is not stored yet");
  return c.body(null, 202);
});

voicemailsRouter.delete("/:id", async (c) => {
  const row = await ownVoicemail(c);
  try {
    await deleteVoicemail(c.env, c.get("db"), row);
  } catch (err) {
    console.error("voicemail delete failed", { voicemailId: row.id, error: String(err) });
    throw new ApiError(502, "delete_failed", "The voicemail could not be deleted. Try again.");
  }
  await notifyOwner(c.env, row.ownerId, { type: "voicemail", voicemailId: row.id }, c.executionCtx);
  return c.body(null, 204);
});
