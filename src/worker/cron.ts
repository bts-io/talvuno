/**
 * Scheduled work, run by the Worker's `scheduled` handler (trigger every 15 minutes in wrangler.jsonc).
 * Each job is independent: one failing is logged and does not stop the others. Jobs must be idempotent and
 * cheap, because a run can repeat or overlap the next one. To add a job, append one line to `cronJobs`.
 */
import { lt } from "drizzle-orm";
import { createDb } from "./db";
import { webhookEvents } from "./db/schema";
import { sendDigests } from "./lib/digest";
import { sendDueScheduled } from "./lib/scheduled";
import { refreshStuckMessages } from "./lib/sms";
import { sweepLeftoverQueues } from "./lib/voice/queues";
import { reconcileStuckCalls } from "./lib/voice/reconcile";
import { pruneCallRecordings, repairCallRecordings } from "./lib/voice/recording";
import { pruneVoicemails, repairVoicemails } from "./lib/voicemail";

export type CronJob = (env: Env, ctx: ExecutionContext) => Promise<void>;

/** webhook_events only exist to recognise Twilio retries, which stop within hours; a month is plenty. */
export const WEBHOOK_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function pruneWebhookEvents(env: Env, _ctx?: ExecutionContext, now = Date.now()): Promise<void> {
  const cutoff = new Date(now - WEBHOOK_EVENT_RETENTION_MS);
  await createDb(env.DB).delete(webhookEvents).where(lt(webhookEvents.receivedAt, cutoff));
}

export const cronJobs: CronJob[] = [
  pruneWebhookEvents,
  refreshStuckMessages,
  reconcileStuckCalls,
  sendDigests,
  repairVoicemails,
  pruneVoicemails,
  repairCallRecordings,
  pruneCallRecordings,
  sweepLeftoverQueues,
  sendDueScheduled,
];

/** Runs every job, each on its own, and waits for all of them. */
export async function runCronJobs(
  env: Env,
  ctx: ExecutionContext,
  jobs: CronJob[] = cronJobs,
): Promise<void> {
  const results = await Promise.allSettled(jobs.map((job) => job(env, ctx)));
  results.forEach((r, i) => {
    if (r.status === "rejected")
      console.error("cron job failed", { job: jobs[i]?.name || `#${i}`, error: String(r.reason) });
  });
}

/** The Worker `scheduled` handler. */
export const scheduled: ExportedHandlerScheduledHandler<Env> = (_controller, env, ctx) => {
  ctx.waitUntil(runCronJobs(env, ctx));
};
