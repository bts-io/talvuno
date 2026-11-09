import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  type ConnectResult,
  type NumberRouting,
  numberPatchSchema,
  numberRoutingSchema,
  type PhoneNumberRow,
} from "../../contracts/numbers";
import { type Db, schema } from "../db";
import { setDefaultNumber } from "../lib/default-number";
import { ApiError } from "../lib/errors";
import { publicUrl, restOrThrow, viaTwilio } from "../lib/twilio-call";
import { validationHook } from "../lib/validation";
import type { AppEnv } from "../types";

/** The owner's Twilio numbers. Mounted at /api/numbers; the owner session is enforced in index.ts. */
export const numbers = new Hono<AppEnv>();

const { phoneNumbers, userPreferences, auditEvents } = schema;

interface TwilioNumber {
  sid: string;
  phone_number: string;
  friendly_name?: string | null;
  capabilities?: { voice?: boolean; sms?: boolean; mms?: boolean } | null;
  voice_url?: string | null;
  voice_method?: string | null;
  sms_url?: string | null;
  sms_method?: string | null;
  status_callback?: string | null;
  status_callback_method?: string | null;
  voice_application_sid?: string | null;
}

const emptyToNull = (v: string | null | undefined) => (v ? v : null);

function routingOf(n: TwilioNumber): NumberRouting {
  return {
    voiceUrl: emptyToNull(n.voice_url),
    voiceMethod: emptyToNull(n.voice_method),
    smsUrl: emptyToNull(n.sms_url),
    smsMethod: emptyToNull(n.sms_method),
    statusCallback: emptyToNull(n.status_callback),
    statusCallbackMethod: emptyToNull(n.status_callback_method),
    voiceApplicationSid: emptyToNull(n.voice_application_sid),
  };
}

/** The webhook URLs this deployment wants a connected number to use. */
function ourRouting(env: Env): NumberRouting {
  const base = publicUrl(env);
  return {
    voiceUrl: `${base}/api/twilio/voice/inbound`,
    voiceMethod: "POST",
    smsUrl: `${base}/api/twilio/sms/inbound`,
    smsMethod: "POST",
    statusCallback: `${base}/api/twilio/voice/status`,
    statusCallbackMethod: "POST",
    voiceApplicationSid: null,
  };
}

const isConnected = (r: NumberRouting, ours: NumberRouting) =>
  r.voiceUrl === ours.voiceUrl &&
  r.voiceMethod === ours.voiceMethod &&
  r.smsUrl === ours.smsUrl &&
  r.smsMethod === ours.smsMethod &&
  r.statusCallback === ours.statusCallback &&
  r.voiceApplicationSid === null;

/** Twilio treats an empty string as "clear this field". */
function routingForm(r: NumberRouting) {
  return {
    VoiceUrl: r.voiceUrl ?? "",
    VoiceMethod: r.voiceMethod ?? undefined,
    SmsUrl: r.smsUrl ?? "",
    SmsMethod: r.smsMethod ?? undefined,
    StatusCallback: r.statusCallback ?? "",
    StatusCallbackMethod: r.statusCallbackMethod ?? undefined,
    VoiceApplicationSid: r.voiceApplicationSid ?? "",
  };
}

/** After numbers come or go: keep a default when any active number exists. */
async function ensureDefault(db: Db, ownerId: string) {
  const active = await db
    .select({ id: phoneNumbers.id, isDefault: phoneNumbers.isDefault })
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.ownerId, ownerId), isNull(phoneNumbers.releasedAt)))
    .orderBy(asc(phoneNumbers.createdAt), asc(phoneNumbers.id));
  const current = active.find((n) => n.isDefault);
  if (current) {
    const [pref] = await db
      .select({ d: userPreferences.defaultNumberId })
      .from(userPreferences)
      .where(eq(userPreferences.userId, ownerId));
    if (pref?.d !== current.id) await setDefaultNumber(db, ownerId, current.id);
    return;
  }
  await setDefaultNumber(db, ownerId, active[0]?.id ?? null);
}

async function audit(
  db: Db,
  ownerId: string,
  action: string,
  target: string,
  metadata: Record<string, unknown>,
  ip: string | undefined,
) {
  await db.insert(auditEvents).values({ ownerId, actor: "owner", action, target, metadata, ip });
}

/** Per number: the routing saved by its latest connect, unless a restore came after it. */
async function restorables(db: Db, ownerId: string): Promise<Map<string, NumberRouting>> {
  const rows = await db
    .select({
      action: auditEvents.action,
      target: auditEvents.target,
      metadata: auditEvents.metadata,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.ownerId, ownerId),
        inArray(auditEvents.action, ["number.connect", "number.restore"]),
      ),
    )
    .orderBy(asc(sql`rowid`));
  const out = new Map<string, NumberRouting>();
  for (const row of rows) {
    if (!row.target) continue;
    if (row.action === "number.restore") {
      out.delete(row.target);
      continue;
    }
    const before = numberRoutingSchema.safeParse((row.metadata as { before?: unknown } | null)?.before);
    if (before.success) out.set(row.target, before.data);
  }
  return out;
}

async function listNumbers(db: Db, ownerId: string): Promise<PhoneNumberRow[]> {
  const [rows, saved] = await Promise.all([
    db
      .select()
      .from(phoneNumbers)
      .where(eq(phoneNumbers.ownerId, ownerId))
      .orderBy(desc(phoneNumbers.isDefault), asc(phoneNumbers.createdAt), asc(phoneNumbers.id)),
    restorables(db, ownerId),
  ]);
  return rows.map((r) => ({
    id: r.id,
    e164: r.e164,
    twilioSid: r.twilioSid,
    friendlyName: r.friendlyName,
    capabilities: r.capabilities,
    isDefault: r.isDefault,
    releasedAt: r.releasedAt ? r.releasedAt.getTime() : null,
    restorable: saved.get(r.id) ?? null,
  }));
}

async function ownedNumber(db: Db, ownerId: string, id: string) {
  const [row] = await db
    .select()
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.id, id), eq(phoneNumbers.ownerId, ownerId)));
  if (!row) throw new ApiError(404, "not_found", "No such number");
  return row;
}

numbers.get("/", async (c) => {
  c.header("cache-control", "no-store");
  return c.json(await listNumbers(c.get("db"), c.get("user")!.id));
});

/** Reads the account's numbers from Twilio and upserts them by SID. Numbers Twilio no longer lists are marked released. */
numbers.post("/sync", async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const rest = restOrThrow(c.env);
  const res = await viaTwilio(() =>
    rest.get<{ incoming_phone_numbers?: TwilioNumber[] }>("/IncomingPhoneNumbers.json", { PageSize: 1000 }),
  );
  const remote = res.incoming_phone_numbers ?? [];
  const seen = new Set<string>();
  let added = 0;
  let updated = 0;

  for (const n of remote) {
    seen.add(n.sid);
    const capabilities = {
      voice: Boolean(n.capabilities?.voice),
      sms: Boolean(n.capabilities?.sms),
      mms: Boolean(n.capabilities?.mms),
    };
    const [bySid] = await db.select().from(phoneNumbers).where(eq(phoneNumbers.twilioSid, n.sid));
    // A re-bought number has a new SID under the same E.164: reuse the row so its history stays attached.
    const [byE164] = bySid
      ? [bySid]
      : await db.select().from(phoneNumbers).where(eq(phoneNumbers.e164, n.phone_number));
    const existing = bySid ?? byE164;
    if (existing && existing.ownerId !== ownerId) continue;
    if (existing) {
      // A number the owner removed stays removed; one Twilio had stopped listing comes back.
      const ownerRemoved = existing.releasedAt && existing.releasedReason === "owner";
      // The owner's own name wins once set; Twilio's friendly name only fills an empty one.
      await db
        .update(phoneNumbers)
        .set({
          twilioSid: n.sid,
          e164: n.phone_number,
          capabilities,
          ...(ownerRemoved ? {} : { releasedAt: null, releasedReason: null }),
          friendlyName: existing.friendlyName || n.friendly_name || "",
        })
        .where(eq(phoneNumbers.id, existing.id));
      updated++;
    } else {
      await db.insert(phoneNumbers).values({
        ownerId,
        e164: n.phone_number,
        twilioSid: n.sid,
        friendlyName: n.friendly_name ?? "",
        capabilities,
      });
      added++;
    }
  }

  const mine = await db
    .select({ id: phoneNumbers.id, twilioSid: phoneNumbers.twilioSid })
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.ownerId, ownerId), isNull(phoneNumbers.releasedAt)));
  const gone = mine.filter((m) => !seen.has(m.twilioSid)).map((m) => m.id);
  for (const id of gone)
    await db
      .update(phoneNumbers)
      .set({ releasedAt: new Date(), releasedReason: "twilio", isDefault: false })
      .where(eq(phoneNumbers.id, id));

  await ensureDefault(db, ownerId);
  await audit(
    db,
    ownerId,
    "number.sync",
    "phone_numbers",
    { added, updated, released: gone.length },
    c.req.header("cf-connecting-ip"),
  );
  return c.json({ added, updated, released: gone.length, numbers: await listNumbers(db, ownerId) });
});

numbers.patch("/:id", zValidator("json", numberPatchSchema, validationHook), async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const row = await ownedNumber(db, ownerId, c.req.param("id"));
  const input = c.req.valid("json");
  if (input.isDefault && row.releasedAt)
    throw new ApiError(409, "released", "A removed number cannot be the default");
  if (input.friendlyName !== undefined)
    await db
      .update(phoneNumbers)
      .set({ friendlyName: input.friendlyName })
      .where(eq(phoneNumbers.id, row.id));
  if (input.isDefault) await setDefaultNumber(db, ownerId, row.id);
  return c.json(await listNumbers(db, ownerId));
});

/**
 * Soft delete. History keeps pointing at the row, and nothing happens at Twilio: the number is not released
 * there and its webhooks stay as they are.
 */
numbers.delete("/:id", async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const row = await ownedNumber(db, ownerId, c.req.param("id"));
  if (!row.releasedAt || row.releasedReason !== "owner")
    await db
      .update(phoneNumbers)
      .set({ releasedAt: row.releasedAt ?? new Date(), releasedReason: "owner", isDefault: false })
      .where(eq(phoneNumbers.id, row.id));
  await ensureDefault(db, ownerId);
  await audit(db, ownerId, "number.remove", row.id, { e164: row.e164 }, c.req.header("cf-connecting-ip"));
  return c.json(await listNumbers(db, ownerId));
});

/** Adds a removed number back. It stays out of sync's way again once Twilio no longer lists it. */
numbers.post("/:id/restore-number", async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const row = await ownedNumber(db, ownerId, c.req.param("id"));
  if (row.releasedAt) {
    await db
      .update(phoneNumbers)
      .set({ releasedAt: null, releasedReason: null })
      .where(eq(phoneNumbers.id, row.id));
    await ensureDefault(db, ownerId);
    await audit(db, ownerId, "number.add_back", row.id, { e164: row.e164 }, c.req.header("cf-connecting-ip"));
  }
  return c.json(await listNumbers(db, ownerId));
});

/**
 * Points the number at this deployment. The routing it had is stored in an audit row first, so /restore can
 * put it back. A number that already points here is left alone and no new audit row is written, so the stored
 * previous values are never overwritten by our own URLs.
 */
numbers.post("/:id/connect", async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const row = await ownedNumber(db, ownerId, c.req.param("id"));
  if (row.releasedAt) throw new ApiError(409, "released", "This number was removed");
  const rest = restOrThrow(c.env);
  const ours = ourRouting(c.env);
  const path = `/IncomingPhoneNumbers/${encodeURIComponent(row.twilioSid)}.json`;

  const current = routingOf(await viaTwilio(() => rest.get<TwilioNumber>(path)));
  if (isConnected(current, ours))
    return c.json({ changed: false, before: current, after: current } satisfies ConnectResult);

  await audit(
    db,
    ownerId,
    "number.connect",
    row.id,
    { e164: row.e164, before: current, requested: ours },
    c.req.header("cf-connecting-ip"),
  );
  const updated = await viaTwilio(() => rest.post<TwilioNumber>(path, routingForm(ours)));
  return c.json({ changed: true, before: current, after: routingOf(updated) } satisfies ConnectResult);
});

/** Puts back the routing stored by the last connect. */
numbers.post("/:id/restore", async (c) => {
  const db = c.get("db");
  const ownerId = c.get("user")!.id;
  const row = await ownedNumber(db, ownerId, c.req.param("id"));
  const previous = (await restorables(db, ownerId)).get(row.id);
  if (!previous) throw new ApiError(404, "nothing_to_restore", "There are no stored previous settings");
  const rest = restOrThrow(c.env);
  const path = `/IncomingPhoneNumbers/${encodeURIComponent(row.twilioSid)}.json`;
  const current = routingOf(await viaTwilio(() => rest.get<TwilioNumber>(path)));
  const updated = await viaTwilio(() => rest.post<TwilioNumber>(path, routingForm(previous)));
  await audit(
    db,
    ownerId,
    "number.restore",
    row.id,
    { e164: row.e164, before: current, restored: previous },
    c.req.header("cf-connecting-ip"),
  );
  return c.json({
    changed: true,
    before: current,
    after: routingOf(updated),
  } satisfies ConnectResult);
});
