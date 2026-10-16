/**
 * Integration job runner (called by scripts/worker.ts).
 *
 *  - 'sync' / 'historical_import': page through provider.fetchSince(); each page is ingested and its checkpoint saved
 *    in ONE org-scoped transaction, so a crash never skips records and a retry never duplicates them.
 *    Pages per run are capped; a continuation job is queued when more remain.
 *  - 'webhook_process': ingest the normalised records stored on a webhook_events row.
 *
 * Errors are re-thrown as PipelineError so the worker's backoff honours Retry-After (429) and treats auth/config
 * failures as non-retryable. Error strings are trimmed and never contain secrets.
 */
import type { Db } from '@/lib/db';
import { withOrg, withSystem } from '@/lib/db';
import type { Job } from '@/lib/pipeline/jobs';
import { enqueue } from '@/lib/pipeline/jobs';
import { PipelineError } from '@/lib/ai/errors';
import { getProvider, PROVIDERS } from '@/lib/providers/registry';
import { errorMessage, ProviderHttpError, RetryableError, sleep } from '@/lib/providers/http';
import type { NormalizedInteraction } from '@/lib/providers/types';
import { ingestRecord, loadIngestSettings, reviveRecord, withSavepoint } from '@/lib/ingestion/ingest';
import { buildContext, canSync, type ConnectionRow } from './connections';

const MAX_PAGES: Record<'sync' | 'historical_import', number> = { sync: 20, historical_import: 40 };
/** Pause between pages, per provider documented rate limits (MyOperator: 20 requests/min). */
const PAGE_DELAY_MS: Record<string, number> = { myoperator: 3500, limechat: 500, gmail: 250, m365: 250 };

export interface RunStats { fetched: number; created: number; updated: number; duplicate: number; failed: number; pages: number }

function toPipelineError(e: unknown): PipelineError {
  if (e instanceof PipelineError) return e;
  const msg = errorMessage(e);
  if (e instanceof RetryableError) return new PipelineError(msg, { retryable: true, retryAfterMs: e.retryAfterMs });
  if (e instanceof ProviderHttpError && [400, 401, 403, 404].includes(e.status)) return new PipelineError(msg, { retryable: false });
  return new PipelineError(msg, { retryable: true });
}

/** Ingest a batch of records inside the current org transaction; each record isolated by a savepoint. */
export async function ingestBatch(db: Db, orgId: string, connectionId: string, records: NormalizedInteraction[], stats: RunStats, errors: string[]) {
  const settings = await loadIngestSettings(db, orgId);
  for (const rec of records) {
    stats.fetched++;
    let err: unknown = null;
    const r = await withSavepoint(db, 'rsi_ingest_rec', async () => {
      try { return await ingestRecord(db, orgId, connectionId, rec, settings); } catch (e) { err = e; throw e; }
    });
    if (!r) {
      stats.failed++;
      if (errors.length < 5) errors.push(`${rec?.sourceRecordId ?? '?'}: ${errorMessage(err, 200)}`);
    } else if (r.status === 'created') stats.created++;
    else if (r.status === 'updated') stats.updated++;
    else stats.duplicate++;
  }
}

async function runSync(job: Job): Promise<void> {
  const kind = job.type as 'sync' | 'historical_import';
  const row = await withSystem((db) => db.one<ConnectionRow>('SELECT * FROM integration_connections WHERE id = $1 AND org_id = $2', [job.connection_id, job.org_id]));
  if (!row) return; // connection deleted — nothing to do
  const p = getProvider(row.provider);
  if (!p?.fetchSince) return;
  if (!canSync(row)) return; // disconnected / untested / never connected: never sync
  if (kind === 'sync' && job.payload?.trigger === 'schedule' && !row.sync_enabled) return;

  const cpKey = kind === 'historical_import' ? 'historical' : 'sync';
  const startCp: Record<string, any> = (row.checkpoint?.[cpKey] as Record<string, any>) ?? {};
  const from = kind === 'historical_import'
    ? new Date(String(job.payload?.from ?? row.historical_from ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)) + 'T00:00:00+05:30')
    : row.last_success_at ? undefined : new Date(Date.now() - 24 * 3600_000); // first incremental sync: last 24 h
  const trigger = kind === 'historical_import' ? 'historical' : job.payload?.trigger === 'manual' ? 'manual' : 'schedule';

  const run = await withOrg(job.org_id, (db) => db.one<{ id: string }>(
    `INSERT INTO integration_sync_runs (org_id, connection_id, trigger, status, checkpoint_before) VALUES ($1,$2,$3,'running',$4) RETURNING id`,
    [job.org_id, row.id, trigger, JSON.stringify(startCp)]));
  const runId = run!.id;
  const stats: RunStats = { fetched: 0, created: 0, updated: 0, duplicate: 0, failed: 0, pages: 0 };
  const errors: string[] = [];
  let cp = startCp;
  let hasMore = true;
  let failure: unknown = null;
  const ctx = buildContext(row);

  try {
    while (hasMore && stats.pages < MAX_PAGES[kind]) {
      const res = await p.fetchSince(ctx, cp, { from });
      stats.pages++;
      await withOrg(job.org_id, async (db) => {
        await ingestBatch(db, job.org_id, row.id, res.records, stats, errors);
        await db.exec(
          `UPDATE integration_connections SET checkpoint = jsonb_set(coalesce(checkpoint, '{}'::jsonb), $2::text[], $3::jsonb, true) WHERE id = $1`,
          [row.id, [cpKey], JSON.stringify(res.checkpoint ?? {})]);
        await db.exec(
          `UPDATE integration_sync_runs SET records_fetched = $2, records_created = $3, records_duplicate = $4, records_failed = $5, checkpoint_after = $6 WHERE id = $1`,
          [runId, stats.fetched, stats.created, stats.duplicate + stats.updated, stats.failed, JSON.stringify(res.checkpoint ?? {})]);
      });
      cp = res.checkpoint ?? {};
      hasMore = !!res.hasMore;
      if (hasMore) await sleep(PAGE_DELAY_MS[p.id] ?? 300);
    }
  } catch (e) {
    failure = e;
  }

  const errText = failure ? errorMessage(failure, 1000) : errors.length ? `Some records failed: ${errors.join(' | ')}`.slice(0, 1000) : null;
  const status = failure ? (stats.fetched > 0 ? 'partial' : 'failed') : stats.failed > 0 ? 'partial' : 'success';
  await withOrg(job.org_id, async (db) => {
    await db.exec(
      `UPDATE integration_sync_runs SET status = $2, finished_at = now(), error = $3, records_fetched = $4, records_created = $5,
              records_duplicate = $6, records_failed = $7, checkpoint_after = $8 WHERE id = $1`,
      [runId, status, errText, stats.fetched, stats.created, stats.duplicate + stats.updated, stats.failed, JSON.stringify(cp)]);
    if (failure) {
      const transient = failure instanceof RetryableError;
      await db.exec(
        `UPDATE integration_connections SET last_sync_at = now(), last_error = $2, last_error_at = now(),
                status = CASE WHEN $3 THEN status ELSE 'error' END WHERE id = $1`, [row.id, errText, transient]);
    } else {
      await db.exec(
        `UPDATE integration_connections SET last_sync_at = now(), last_success_at = now(),
                last_error = CASE WHEN $2::text IS NULL THEN NULL ELSE $2 END, last_error_at = CASE WHEN $2::text IS NULL THEN last_error_at ELSE now() END,
                status = CASE WHEN status = 'error' THEN 'connected' ELSE status END
          WHERE id = $1`, [row.id, errText]);
      if (hasMore) {
        // Page cap reached: continue in a fresh job so other work can interleave.
        await enqueue(db, job.org_id, kind, { connectionId: row.id, dedupeKey: `${kind}-cont:${row.id}`, payload: { ...job.payload, continuation: true }, priority: 110 });
      }
    }
  });
  if (failure) throw toPipelineError(failure);
}

async function processWebhook(job: Job): Promise<void> {
  const eventId = String(job.payload?.eventId ?? '');
  const ev = await withSystem((db) => db.one<{ id: string; org_id: string; connection_id: string; status: string; payload: any }>(
    'SELECT id, org_id, connection_id, status, payload FROM webhook_events WHERE id = $1 AND org_id = $2', [eventId, job.org_id]));
  if (!ev || ev.status === 'processed' || ev.status === 'ignored') return;
  const records: NormalizedInteraction[] = (Array.isArray(ev.payload?.records) ? ev.payload.records : []).map(reviveRecord);
  const stats: RunStats = { fetched: 0, created: 0, updated: 0, duplicate: 0, failed: 0, pages: 1 };
  const errors: string[] = [];
  try {
    await withOrg(job.org_id, async (db) => {
      await ingestBatch(db, job.org_id, ev.connection_id, records, stats, errors);
      if (stats.failed > 0) throw new Error(`Could not ingest ${stats.failed} record(s): ${errors.join(' | ')}`);
      await db.exec(`UPDATE webhook_events SET status = 'processed', processed_at = now(), error = NULL WHERE id = $1`, [ev.id]);
      await db.exec(`UPDATE integration_connections SET last_success_at = now() WHERE id = $1`, [ev.connection_id]);
    });
  } catch (e) {
    const msg = errorMessage(e, 1000);
    await withSystem((db) => db.exec(`UPDATE webhook_events SET status = 'failed', error = $2 WHERE id = $1`, [ev.id, msg]));
    throw toPipelineError(e);
  }
}

/** Runs a 'sync' | 'historical_import' | 'webhook_process' job. Throw to fail (worker applies backoff). */
export async function runIntegrationJob(_db: Db, job: Job): Promise<void> {
  switch (job.type) {
    case 'sync':
    case 'historical_import':
      return runSync(job);
    case 'webhook_process':
      return processWebhook(job);
    default:
      throw new PipelineError(`Job type ${job.type} is not an integration job`, { retryable: false });
  }
}

/** Enqueue syncs that are due per connection.sync_frequency_minutes. Returns count queued. */
export async function enqueueDueSyncs(db: Db): Promise<number> {
  const pollable = PROVIDERS.filter((p) => p.supportsPolling && p.fetchSince).map((p) => p.id);
  const due = await db.query<{ id: string; org_id: string }>(
    `SELECT id, org_id FROM integration_connections
      WHERE sync_enabled AND status IN ('connected','error') AND provider = ANY($1)
        AND (last_sync_at IS NULL OR last_sync_at < now() - make_interval(mins => sync_frequency_minutes))`, [pollable]);
  let n = 0;
  for (const c of due) {
    const id = await enqueue(db, c.org_id, 'sync', { connectionId: c.id, dedupeKey: `sync:${c.id}`, payload: { trigger: 'schedule' }, priority: 100 });
    if (id) n++;
  }
  return n;
}
