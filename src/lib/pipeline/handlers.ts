/**
 * Job dispatch for the worker (scripts/worker.ts) and any in-process runner.
 * Returns 'done' (caller completes the job) or 'deferred' (handler already re-queued it, e.g. long Sarvam batch polling).
 * Throw to fail: the caller applies backoff via failJob(), honouring ProviderError/PipelineError.retryable + retryAfterMs.
 */
import { withSystem } from '@/lib/db';
import { claimJobs, completeJob, failJob, enqueue, type Job } from './jobs';
import { runAnalyzeJob } from './analyze';
import { runTranscribeJob } from './transcribe';
import { runSlaCheckJob } from './sla';
import { runRetentionJob } from './retention';
import { runNotifyJob } from './notify-email';
import { runIntegrationJob, enqueueDueSyncs } from '@/lib/integrations/sync';
import { errorMessage, isRetryable, retryAfterOf } from '@/lib/ai/errors';

export type HandlerOutcome = { status: 'done' | 'deferred'; info?: Record<string, unknown> };

export async function handleJob(job: Job): Promise<HandlerOutcome> {
  switch (job.type) {
    case 'transcribe': {
      const r = await runTranscribeJob(job);
      return r.status === 'deferred' ? { status: 'deferred' } : { status: 'done', info: { segments: r.segments } };
    }
    case 'analyze': {
      const r = await runAnalyzeJob(job);
      return { status: 'done', info: { result: r.status, score: r.score, flags: r.flags, provider: r.provider } };
    }
    case 'sla_check': return { status: 'done', info: await runSlaCheckJob(job) };
    case 'retention': return { status: 'done', info: await runRetentionJob(job) };
    case 'notify': return { status: 'done', info: await runNotifyJob(job) };
    case 'sync':
    case 'historical_import':
    case 'webhook_process':
      await withSystem((db) => runIntegrationJob(db, job));
      return { status: 'done' };
    default:
      throw Object.assign(new Error(`Unknown job type ${(job as Job).type}`), { retryable: false });
  }
}

/** Run one claimed job end-to-end with completion / failure bookkeeping. Never throws. */
export async function runClaimedJob(job: Job, log: (msg: string) => void = () => {}): Promise<HandlerOutcome | { status: 'failed' | 'dead'; error: string }> {
  const started = Date.now();
  try {
    const out = await handleJob(job);
    if (out.status === 'done') await withSystem((db) => completeJob(db, job.id));
    log(`${job.type} ${job.id.slice(0, 8)} ${out.status} in ${Date.now() - started}ms${out.info ? ' ' + JSON.stringify(out.info) : ''}`);
    return out;
  } catch (e) {
    const msg = errorMessage(e);
    const retryable = (e as any)?.retryable === false ? false : isRetryable(e);
    const dead = await withSystem((db) => failJob(db, job, msg, { retryable, retryAfterMs: retryAfterOf(e) })).catch(() => true);
    log(`${job.type} ${job.id.slice(0, 8)} ${dead ? 'DEAD' : 'failed (will retry)'} attempt ${job.attempts}/${job.max_attempts}: ${msg.slice(0, 200)}`);
    return { status: dead ? 'dead' : 'failed', error: msg };
  }
}

/** Claim and run up to `limit` jobs once (used by scripts and tests). */
export async function processOnce(workerId: string, limit = 5, types?: Job['type'][], log?: (m: string) => void) {
  const jobs = await withSystem((db) => claimJobs(db, workerId, limit, types));
  const results = [];
  for (const j of jobs) results.push(await runClaimedJob(j, log));
  return results;
}

/**
 * Periodic scheduling (worker loop or an external cron tick):
 *  - integration syncs that are due
 *  - sla_check per org every 15 minutes
 *  - retention per org once a day
 */
export async function enqueueScheduledJobs(opts: { sla?: boolean; retention?: boolean; syncs?: boolean } = {}) {
  const res = { syncs: 0, sla: 0, retention: 0 };
  if (opts.syncs !== false) res.syncs = await withSystem((db) => enqueueDueSyncs(db)).catch(() => 0);
  if (opts.sla || opts.retention) {
    await withSystem(async (db) => {
      const orgs = await db.query<{ id: string }>('SELECT id FROM organizations');
      for (const o of orgs) {
        if (opts.sla) {
          const bucket = Math.floor(Date.now() / (15 * 60_000));
          if (await enqueue(db, o.id, 'sla_check', { dedupeKey: `sla:${o.id}`, priority: 120, maxAttempts: 2, payload: { bucket } })) res.sla++;
        }
        if (opts.retention) {
          const recent = await db.one(
            `SELECT 1 FROM processing_jobs WHERE org_id = $1 AND type = 'retention' AND (status IN ('queued','running') OR (status = 'succeeded' AND finished_at > now() - interval '23 hours')) LIMIT 1`, [o.id]);
          if (!recent && await enqueue(db, o.id, 'retention', { dedupeKey: `retention:${o.id}`, priority: 200, maxAttempts: 3 })) res.retention++;
        }
      }
    });
  }
  return res;
}
