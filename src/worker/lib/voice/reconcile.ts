/**
 * Cron catch-up for calls whose final status callback never arrived. Asks Twilio for the final state of every
 * call still non-terminal two hours after it started and applies it through the same rules as a webhook
 * (the dialed child legs first, since they hold the call's result; the parent leg otherwise). An inbound call
 * can have one child leg per ringing device: a completed one is the leg that was answered, so it wins over the
 * others' canceled or no-answer ends. Whatever is chosen is applied as the dial result. No push: a missed
 * call notice two hours late would only confuse.
 */
import { and, inArray, lt } from "drizzle-orm";
import { CALL_STATUSES, isTerminalCallStatus } from "../../../contracts";
import { createDb, schema } from "../../db";
import { TwilioApiError, TwilioNotConfiguredError, type TwilioRest, twilioRest } from "../twilio/rest";
import { applyCallEvent, parseCallStatus, parseDuration } from "./calls";

export const STUCK_CALL_AGE_MS = 2 * 60 * 60 * 1000;
/** Calls checked per run; the rest wait for the next run. */
export const RECONCILE_BATCH = 25;
/** Child legs read per call: one per ringing device, so a few more than anyone has devices. */
const CHILD_PAGE = 20;

const OPEN = CALL_STATUSES.filter((s) => !isTerminalCallStatus(s));

type TwilioCall = { sid: string; status: string; duration?: string | null; end_time?: string | null };

const endTime = (c: TwilioCall, fallback: Date) => {
  const t = c.end_time ? Date.parse(c.end_time) : Number.NaN;
  return Number.isFinite(t) ? new Date(t) : fallback;
};

export async function reconcileStuckCalls(
  env: Env,
  _ctx?: ExecutionContext,
  now = Date.now(),
): Promise<void> {
  const db = createDb(env.DB);
  const stuck = await db
    .select({ sid: schema.calls.twilioCallSid })
    .from(schema.calls)
    .where(
      and(inArray(schema.calls.status, OPEN), lt(schema.calls.startedAt, new Date(now - STUCK_CALL_AGE_MS))),
    )
    .limit(RECONCILE_BATCH);
  if (!stuck.length) return;

  let rest: TwilioRest;
  try {
    rest = twilioRest(env);
  } catch (err) {
    if (err instanceof TwilioNotConfiguredError) return;
    throw err;
  }
  const at = new Date(now);
  const quiet = { push: false };
  for (const { sid } of stuck) {
    try {
      const children = await rest.get<{ calls?: TwilioCall[] }>("/Calls.json", {
        ParentCallSid: sid,
        PageSize: CHILD_PAGE,
      });
      const ended = (children.calls ?? []).filter((c) => {
        const s = parseCallStatus(c.status);
        return s !== null && isTerminalCallStatus(s);
      });
      const child = ended.find((c) => c.status === "completed") ?? ended[0];
      if (child) {
        const status = parseCallStatus(child.status)!;
        const duration = parseDuration(child.duration);
        await applyCallEvent(env, db, sid, { leg: "dial", status, duration, at: endTime(child, at) }, quiet);
        continue;
      }
      const parent = await rest.get<TwilioCall>(`/Calls/${encodeURIComponent(sid)}.json`);
      const status = parseCallStatus(parent.status);
      if (!status || !isTerminalCallStatus(status)) continue;
      // No dialed leg reached a final state: the call ended before anyone answered.
      const final = status === "completed" ? "canceled" : status;
      await applyCallEvent(
        env,
        db,
        sid,
        { leg: "dial", status: final, duration: 0, at: endTime(parent, at) },
        quiet,
      );
    } catch (err) {
      if (err instanceof TwilioApiError && err.status === 404) {
        // Twilio has no such call: close the row instead of asking forever.
        await applyCallEvent(env, db, sid, { leg: "dial", status: "failed", duration: 0, at }, quiet);
        continue;
      }
      console.error("call reconcile failed", { sid, error: String(err) });
    }
  }
}
