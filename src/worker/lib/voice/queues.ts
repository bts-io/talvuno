/**
 * Cron sweep for Twilio Queues the call flow left behind. Each inbound call gets its own queue (`tq_...`),
 * deleted when the caller leaves it, but a missed webhook would keep it forever. This lists the account's
 * queues and deletes the empty, old, `tq_` ones. It never throws: a failure is logged and the next run tries
 * again.
 */
import { TwilioNotConfiguredError, twilioRest } from "../twilio/rest";

export const QUEUE_PREFIX = "tq_";
/** An empty queue younger than this may belong to a call that is only now being placed in it. */
export const QUEUE_SWEEP_AGE_MS = 10 * 60 * 1000;
const PAGE_SIZE = 100;
/** Pages read per run, so one run stays cheap. A big backlog clears over several runs. */
const MAX_PAGES = 5;
const REQUEST_TIMEOUT_MS = 8000;

type TwilioQueue = { sid: string; friendly_name?: string; current_size?: number; date_created?: string };
type QueuePage = { queues?: TwilioQueue[]; next_page_uri?: string | null };

export async function sweepLeftoverQueues(
  env: Env,
  _ctx?: ExecutionContext,
  now = Date.now(),
): Promise<void> {
  let rest: ReturnType<typeof twilioRest>;
  try {
    rest = twilioRest(env);
  } catch (err) {
    if (err instanceof TwilioNotConfiguredError) return;
    console.warn("queue sweep failed", { error: String(err) });
    return;
  }
  try {
    let query: Record<string, string> = { PageSize: String(PAGE_SIZE) };
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await rest.get<QueuePage>("/Queues.json", query, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      for (const q of body.queues ?? []) {
        if (!q.sid || !/^QU[0-9a-f]{32}$/i.test(q.sid)) continue;
        if (!q.friendly_name?.startsWith(QUEUE_PREFIX) || q.current_size !== 0) continue;
        const created = q.date_created ? Date.parse(q.date_created) : Number.NaN;
        if (!Number.isFinite(created) || now - created < QUEUE_SWEEP_AGE_MS) continue;
        try {
          await rest.delete(`/Queues/${q.sid}.json`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        } catch (err) {
          console.warn("queue delete failed", { queueSid: q.sid, error: String(err) });
        }
      }
      if (!body.next_page_uri) break;
      query = Object.fromEntries(new URL(body.next_page_uri, "https://twilio.invalid").searchParams);
    }
  } catch (err) {
    console.warn("queue sweep failed", { error: String(err) });
  }
}
