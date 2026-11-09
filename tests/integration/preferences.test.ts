import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../../src/worker/db";
import { DEFAULT_PREFERENCES, getPreferences } from "../../src/worker/lib/preferences";
import { createOwner, resetDb } from "./helpers";

beforeEach(resetDb);

describe("preferences", () => {
  it("creates the default row when the owner is set up", async () => {
    const { userId } = await createOwner();
    const rows = await env.DB.prepare(
      "SELECT sms_per_hour, calls_per_hour, locale FROM user_preferences",
    ).all();
    expect(rows.results).toEqual([{ sms_per_hour: 30, calls_per_hour: 20, locale: "en" }]);
    expect(await getPreferences(createDb(env.DB), userId)).toEqual(DEFAULT_PREFERENCES);
  });

  it("returns the defaults when no row exists", async () => {
    expect(await getPreferences(createDb(env.DB), "nobody")).toEqual(DEFAULT_PREFERENCES);
  });

  it("returns the stored values", async () => {
    const { userId } = await createOwner();
    await env.DB.prepare("UPDATE user_preferences SET sms_per_hour = 5, theme = 'dark' WHERE user_id = ?")
      .bind(userId)
      .run();
    expect(await getPreferences(createDb(env.DB), userId)).toMatchObject({ smsPerHour: 5, theme: "dark" });
  });
});
