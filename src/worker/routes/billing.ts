import { Hono } from "hono";
import type { Billing, BillingUsageLine } from "../../contracts/numbers";
import { restOrThrow, viaTwilio } from "../lib/twilio-call";
import type { AppEnv } from "../types";

/** Read-only account balance and this month's usage. Mounted at /api/billing. */
export const billing = new Hono<AppEnv>();

export const BILLING_TTL_MS = 5 * 60 * 1000;

// Per isolate, per account. Twilio's balance and usage endpoints are slow and rate limited, and the numbers
// move slowly, so a settings screen opened repeatedly should not hit them each time.
const cache = new Map<string, { at: number; value: Billing }>();

/** Empties the cache (tests). */
export const clearBillingCache = () => cache.clear();

interface UsageRecord {
  count?: string | null;
  usage?: string | null;
  usage_unit?: string | null;
  price?: string | null;
  price_unit?: string | null;
  start_date?: string | null;
  end_date?: string | null;
}

const line = (r: UsageRecord | undefined): BillingUsageLine => ({
  count: r?.count ?? null,
  usage: r?.usage ?? null,
  usageUnit: r?.usage_unit ?? null,
  price: r?.price ?? null,
  priceUnit: r?.price_unit ?? null,
});

billing.get("/", async (c) => {
  const rest = restOrThrow(c.env);
  c.header("cache-control", "no-store");
  const hit = cache.get(rest.accountSid);
  if (hit && Date.now() - hit.at < BILLING_TTL_MS) return c.json(hit.value);

  const usageOf = async (category: string) => {
    const res = await rest.get<{ usage_records?: UsageRecord[] }>("/Usage/Records/ThisMonth.json", {
      Category: category,
    });
    return res.usage_records?.[0];
  };
  const [balance, calls, sms, total] = await viaTwilio(() =>
    Promise.all([
      rest.get<{ balance?: string; currency?: string }>("/Balance.json"),
      usageOf("calls"),
      usageOf("sms"),
      usageOf("totalprice"),
    ]),
  );
  const value: Billing = {
    balance: { amount: balance.balance ?? "0", currency: balance.currency ?? "USD" },
    period: {
      start: total?.start_date ?? calls?.start_date ?? null,
      end: total?.end_date ?? calls?.end_date ?? null,
      label: "this month",
    },
    usage: { calls: line(calls), sms: line(sms), total: line(total) },
    fetchedAt: Date.now(),
  };
  cache.set(rest.accountSid, { at: Date.now(), value });
  return c.json(value);
});
