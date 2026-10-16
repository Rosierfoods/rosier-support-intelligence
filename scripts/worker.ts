/**
 * Background worker: `npm run worker`
 *  - polls processing_jobs (claimJobs, FOR UPDATE SKIP LOCKED) with WORKER_CONCURRENCY parallel slots
 *  - requeueStale() every minute; enqueueDueSyncs() every minute
 *  - sla_check per org every 15 minutes; retention per org daily
 *  - graceful shutdown on SIGTERM/SIGINT (stops claiming, waits for running jobs up to 60 s)
 * Logs job type/id/outcome only — never secrets, transcripts or message contents.
 *
 * Flags: --once (process what is due, then exit) · --types=analyze,transcribe · --max=N (stop after N jobs)
 */
import './_env';
import { hostname } from 'node:os';
import { withSystem, getPool } from '@/lib/db';
import { claimJobs, requeueStale, type Job, type JobType } from '@/lib/pipeline/jobs';
import { enqueueScheduledJobs, runClaimedJob } from '@/lib/pipeline/handlers';

const args = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true']; }));
const CONCURRENCY = Math.max(1, Math.min(32, Number(process.env.WORKER_CONCURRENCY ?? 3)));
const POLL_MS = Math.max(500, Number(process.env.WORKER_POLL_MS ?? 3000));
const ONCE = args.has('once');
const MAX = args.has('max') ? Number(args.get('max')) : Infinity;
const TYPES = args.get('types')?.split(',').filter(Boolean) as JobType[] | undefined;
const WORKER_ID = `${hostname()}:${process.pid}`;

const log = (msg: string) => console.log(`${new Date().toISOString()} [worker] ${msg}`);
const running = new Set<Promise<unknown>>();
let stopping = false;
let processed = 0;
let lastMinute = 0, lastSla = 0, lastRetentionCheck = 0;

async function maintenance() {
  const now = Date.now();
  if (now - lastMinute >= 60_000) {
    lastMinute = now;
    try {
      const n = await withSystem((db) => requeueStale(db, 15));
      if (n) log(`requeued ${n} stale job(s)`);
    } catch (e) { log(`requeueStale error: ${(e as Error).message}`); }
    const doSla = now - lastSla >= 15 * 60_000;
    const doRetention = now - lastRetentionCheck >= 60 * 60_000; // checks hourly; enqueues at most once per 23 h per org
    try {
      const r = await enqueueScheduledJobs({ syncs: true, sla: doSla, retention: doRetention });
      if (doSla) lastSla = now;
      if (doRetention) lastRetentionCheck = now;
      if (r.syncs || r.sla || r.retention) log(`scheduled syncs=${r.syncs} sla=${r.sla} retention=${r.retention}`);
    } catch (e) { log(`scheduler error: ${(e as Error).message}`); }
  }
}

async function tick(): Promise<number> {
  const free = CONCURRENCY - running.size;
  if (free <= 0 || stopping || processed >= MAX) return 0;
  let jobs: Job[] = [];
  try {
    jobs = await withSystem((db) => claimJobs(db, WORKER_ID, Math.min(free, MAX - processed), TYPES));
  } catch (e) {
    log(`claim error: ${(e as Error).message}`);
    return 0;
  }
  for (const j of jobs) {
    processed++;
    const p = runClaimedJob(j, log).finally(() => running.delete(p));
    running.add(p);
  }
  return jobs.length;
}

async function main() {
  log(`started id=${WORKER_ID} concurrency=${CONCURRENCY} poll=${POLL_MS}ms${TYPES ? ` types=${TYPES.join(',')}` : ''}${ONCE ? ' (once)' : ''}`);
  if (!ONCE) await maintenance();
  for (;;) {
    if (stopping) break;
    if (!ONCE) await maintenance();
    const claimed = await tick();
    if (ONCE && claimed === 0 && running.size === 0) break;
    if (processed >= MAX && running.size === 0) break;
    if (claimed === 0 || running.size >= CONCURRENCY) {
      await Promise.race([new Promise((r) => setTimeout(r, ONCE ? 300 : POLL_MS)), ...(running.size >= CONCURRENCY ? Array.from(running) : [])]);
    }
  }
  await drain();
}

async function drain() {
  if (running.size) {
    log(`waiting for ${running.size} running job(s)…`);
    await Promise.race([Promise.allSettled(Array.from(running)), new Promise((r) => setTimeout(r, 60_000))]);
  }
  await getPool().end().catch(() => {});
  log(`stopped after ${processed} job(s)`);
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    log(`${sig} received — finishing running jobs (send again to force exit)`);
  });
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
