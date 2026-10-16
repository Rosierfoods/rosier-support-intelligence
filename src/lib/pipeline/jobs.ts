import type { Db } from '@/lib/db';

/**
 * Postgres-backed job queue (no Redis needed).
 * - enqueue(): idempotent per (org, dedupe_key) while a job is queued/running.
 * - claimJobs(): FOR UPDATE SKIP LOCKED so several workers can run safely.
 * - failJob(): exponential backoff (30s · 2^attempt, max 6h); after max_attempts → 'dead' (visible in UI, retryable).
 */
export type JobType = 'sync' | 'historical_import' | 'webhook_process' | 'transcribe' | 'analyze' | 'notify' | 'retention' | 'sla_check';

export interface Job {
  id: string; org_id: string; type: JobType; interaction_id: string | null; connection_id: string | null;
  payload: Record<string, any>; attempts: number; max_attempts: number;
}

export async function enqueue(db: Db, orgId: string, type: JobType, opts: {
  interactionId?: string | null; connectionId?: string | null; payload?: Record<string, unknown>;
  dedupeKey?: string | null; priority?: number; runAfter?: Date; maxAttempts?: number;
} = {}): Promise<string | null> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO processing_jobs (org_id, type, interaction_id, connection_id, payload, dedupe_key, priority, run_after, max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running') DO NOTHING
     RETURNING id`,
    [orgId, type, opts.interactionId ?? null, opts.connectionId ?? null, JSON.stringify(opts.payload ?? {}),
      opts.dedupeKey ?? null, opts.priority ?? 100, opts.runAfter ?? new Date(), opts.maxAttempts ?? 5],
  );
  return row?.id ?? null;
}

/** System context only (worker). */
export async function claimJobs(db: Db, workerId: string, limit: number, types?: JobType[]): Promise<Job[]> {
  return db.query<Job>(
    `UPDATE processing_jobs j SET status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1, updated_at = now()
      WHERE j.id IN (
        SELECT id FROM processing_jobs
         WHERE status = 'queued' AND run_after <= now() ${types?.length ? 'AND type = ANY($3)' : ''}
         ORDER BY priority ASC, run_after ASC
         LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING j.id, j.org_id, j.type, j.interaction_id, j.connection_id, j.payload, j.attempts, j.max_attempts`,
    types?.length ? [workerId, limit, types] : [workerId, limit],
  );
}

export async function completeJob(db: Db, id: string) {
  await db.exec(`UPDATE processing_jobs SET status = 'succeeded', finished_at = now(), locked_at = NULL, last_error = NULL WHERE id = $1`, [id]);
}

export function backoffMs(attempt: number) {
  return Math.min(6 * 3600_000, 30_000 * 2 ** Math.max(0, attempt - 1));
}

export async function failJob(db: Db, job: Pick<Job, 'id' | 'attempts' | 'max_attempts'>, error: string, opts: { retryable?: boolean; retryAfterMs?: number } = {}) {
  const dead = opts.retryable === false || job.attempts >= job.max_attempts;
  const delay = opts.retryAfterMs ?? backoffMs(job.attempts);
  await db.exec(
    `UPDATE processing_jobs SET status = $2, last_error = $3, locked_at = NULL,
       run_after = CASE WHEN $2 = 'queued' THEN now() + ($4 || ' milliseconds')::interval ELSE run_after END,
       finished_at = CASE WHEN $2 = 'dead' THEN now() ELSE NULL END
     WHERE id = $1`,
    [job.id, dead ? 'dead' : 'queued', error.slice(0, 2000), String(delay)],
  );
  return dead;
}

/** Recover jobs whose worker died mid-run. */
export async function requeueStale(db: Db, staleMinutes = 15) {
  return db.exec(
    `UPDATE processing_jobs SET status = 'queued', locked_at = NULL, last_error = coalesce(last_error, '') || ' [requeued after stale lock]'
      WHERE status = 'running' AND locked_at < now() - ($1 || ' minutes')::interval`,
    [String(staleMinutes)],
  );
}

/** User-triggered retry of a dead/failed job (permission checked by caller). */
export async function retryJob(db: Db, id: string) {
  return db.exec(
    `UPDATE processing_jobs SET status = 'queued', attempts = 0, run_after = now(), last_error = NULL, finished_at = NULL
      WHERE id = $1 AND status IN ('dead','failed','cancelled')`,
    [id],
  );
}

/** Queue the right next step for an interaction (transcribe calls with recordings, otherwise analyze). */
export async function enqueueProcessing(db: Db, orgId: string, interactionId: string, opts: { force?: boolean; reason?: string } = {}) {
  const row = await db.one<{ channel: string; recording_available: boolean | null; has_transcript: boolean; call_status: string | null }>(
    `SELECT i.channel, c.recording_available, c.call_status,
            EXISTS (SELECT 1 FROM call_transcripts t WHERE t.interaction_id = i.id AND t.is_current AND t.status = 'completed') AS has_transcript
       FROM interactions i LEFT JOIN calls c ON c.interaction_id = i.id WHERE i.id = $1`, [interactionId]);
  if (!row) return null;
  if (row.channel === 'call') {
    if (row.call_status && row.call_status !== 'answered') {
      await db.exec(`UPDATE interactions SET processing_status = 'completed' WHERE id = $1`, [interactionId]);
      return null;
    }
    if (!row.has_transcript || opts.force === true && opts.reason === 'retranscribe') {
      if (!row.recording_available) {
        await db.exec(`UPDATE interactions SET processing_status = 'failed', processing_error = 'No authorised recording is available for this call.' WHERE id = $1`, [interactionId]);
        return null;
      }
      await db.exec(`UPDATE interactions SET processing_status = 'transcription_pending', processing_error = NULL WHERE id = $1`, [interactionId]);
      return enqueue(db, orgId, 'transcribe', { interactionId, dedupeKey: `transcribe:${interactionId}`, priority: 50, payload: { reason: opts.reason ?? null } });
    }
  }
  await db.exec(`UPDATE interactions SET processing_status = 'analysis_pending', processing_error = NULL WHERE id = $1`, [interactionId]);
  return enqueue(db, orgId, 'analyze', { interactionId, dedupeKey: `analyze:${interactionId}`, priority: 60, payload: { reason: opts.reason ?? null } });
}

/**
 * Re-queue a running job to continue later without consuming an attempt (e.g. polling a long Sarvam batch job).
 * `payloadPatch` is merged into the job payload so the next run can resume.
 */
export async function deferJob(db: Db, job: Pick<Job, 'id'>, delayMs: number, payloadPatch: Record<string, unknown> = {}) {
  await db.exec(
    `UPDATE processing_jobs SET status = 'queued', locked_at = NULL, attempts = GREATEST(attempts - 1, 0),
       run_after = now() + ($2 || ' milliseconds')::interval, payload = payload || $3::jsonb
     WHERE id = $1`,
    [job.id, String(Math.max(1000, Math.round(delayMs))), JSON.stringify(payloadPatch)],
  );
}
