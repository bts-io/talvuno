import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../../src/worker/db";
import { ApiError } from "../../src/worker/lib/errors";
import { assertCanContact } from "../../src/worker/lib/twilio/guards";
import { createOwner, resetDb } from "./helpers";

beforeEach(resetDb);

const US = "+14155552671";
const UK = "+447911123456";

const ctx = () => {
  const db = createDb(env.DB);
  return { env, get: ((key: string) => (key === "db" ? db : undefined)) as never };
};

async function setPrefs(ownerId: string, allow: string[], smsPerHour = 30, callsPerHour = 20) {
  await env.DB.prepare(
    "INSERT INTO user_preferences (user_id, country_allowlist, sms_per_hour, calls_per_hour, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET country_allowlist = excluded.country_allowlist, sms_per_hour = excluded.sms_per_hour, calls_per_hour = excluded.calls_per_hour, updated_at = excluded.updated_at",
  )
    .bind(ownerId, JSON.stringify(allow), smsPerHour, callsPerHour, Date.now())
    .run();
}

async function refusal(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return { status: (err as ApiError).status, code: (err as ApiError).code };
}

describe("assertCanContact", () => {
  it("refuses everything while the owner has no preferences (empty allowlist)", async () => {
    const { userId } = await createOwner();
    expect(await refusal(assertCanContact(ctx(), userId, US, "sms"))).toEqual({
      status: 403,
      code: "country_not_allowed",
    });
  });

  it("allows a number in the allowlist and refuses one outside it", async () => {
    const { userId } = await createOwner();
    await setPrefs(userId, ["US"]);
    await expect(assertCanContact(ctx(), userId, US, "call")).resolves.toBeUndefined();
    expect(await refusal(assertCanContact(ctx(), userId, UK, "call"))).toEqual({
      status: 403,
      code: "country_not_allowed",
    });
  });

  it("refuses short codes and malformed numbers", async () => {
    const { userId } = await createOwner();
    await setPrefs(userId, ["US"]);
    for (const n of [
      "12345",
      "+1415",
      "4155552671",
      "+1 415 555 2671",
      "anonymous",
      "restricted",
      "Talvuno",
      "",
    ])
      expect(await refusal(assertCanContact(ctx(), userId, n, "sms"))).toEqual({
        status: 400,
        code: "invalid_number",
      });
  });

  it("enforces the per-hour limit per kind, and refused countries spend nothing", async () => {
    const { userId } = await createOwner();
    await setPrefs(userId, ["US"], 2, 1);
    await refusal(assertCanContact(ctx(), userId, UK, "sms"));
    await assertCanContact(ctx(), userId, US, "sms");
    await assertCanContact(ctx(), userId, US, "sms");
    expect(await refusal(assertCanContact(ctx(), userId, US, "sms"))).toEqual({
      status: 429,
      code: "rate_limited",
    });
    await assertCanContact(ctx(), userId, US, "call");
    expect(await refusal(assertCanContact(ctx(), userId, US, "call"))).toEqual({
      status: 429,
      code: "rate_limited",
    });
  });

  it("refuses premium-rate numbers before spending a send", async () => {
    const { userId } = await createOwner();
    await setPrefs(userId, ["US", "GB"], 1, 1);
    for (const n of ["+19005550123", "+449090901234"])
      expect(await refusal(assertCanContact(ctx(), userId, n, "call"))).toEqual({
        status: 403,
        code: "premium_rate",
      });
    await expect(assertCanContact(ctx(), userId, US, "call")).resolves.toBeUndefined();
  });

  it("treats a limit of zero as no sends at all", async () => {
    const { userId } = await createOwner();
    await setPrefs(userId, ["US"], 0, 0);
    expect((await refusal(assertCanContact(ctx(), userId, US, "sms"))).status).toBe(429);
  });
});
