/**
 * In-process worker loop, used when the background worker runs inside the web server
 * (RUN_WORKER_IN_WEB=true — e.g. a single free-tier web service). Same logic as scripts/worker.ts.
 */
import { hostname } from 'node:os';
import { withSystem } from '@/lib/db';
import { claimJobs, requeueStale, type Job } from './jobs';
import { enqueueScheduledJobs, runClaimedJob } from './handlers';
import { runOrderMatchingBatch } from '@/lib/orders/enrich';
import { runTicketBackfillBatch } from '@/lib/orders/tickets';

const g = globalThis as unknown as { __rsiWorkerStarted?: boolean };

export function startWorkerLoop(opts: { concurrency?: number; pollMs?: number } = {}) {
  if (g.__rsiWorkerStarted) return;
  g.__rsiWorkerStarted = true;
  const concurrency = Math.max(1, Math.min(8, opts.concurrency ?? Number(process.env.WORKER_CONCURRENCY ?? 2)));
  const pollMs = Math.max(1000, opts.pollMs ?? Number(process.env.WORKER_POLL_MS ?? 5000));
  const id = `${hostname()}:${process.pid}:web`;
  const log = (m: string) => console.log(`${new Date().toISOString()} [worker] ${m}`);
  const running = new Set<Promise<unknown>>();
  let lastMinute = 0, lastSla = 0, lastRetention = 0;

  async function maintenance() {
    const now = Date.now();
    if (now - lastMinute < 60_000) return;
    lastMinute = now;
    try { const n = await withSystem((db) => requeueStale(db, 15)); if (n) log(`requeued ${n} stale job(s)`); }
    catch (e) { log(`requeueStale error: ${(e as Error).message}`); }
    const doSla = now - lastSla >= 15 * 60_000;
    const doRetention = now - lastRetention >= 60 * 60_000;
    try {
      const r = await enqueueScheduledJobs({ syncs: true, sla: doSla, retention: doRetention });
      if (doSla) lastSla = now;
      if (doRetention) lastRetention = now;
      if (r.syncs || r.sla || r.retention) log(`scheduled syncs=${r.syncs} sla=${r.sla} retention=${r.retention}`);
    } catch (e) { log(`scheduler error: ${(e as Error).message}`); }
    try { const n = await runOrderMatchingBatch(log); if (n) log(`order matching: ${n} checked`); }
    catch (e) { log(`order matching error: ${(e as Error).message}`); }
    try { const n = await runTicketBackfillBatch(log); if (n) log(`tickets back-filled: ${n}`); }
    catch (e) { log(`ticket backfill error: ${(e as Error).message}`); }
  }

  async function loop() {
    log(`started in web process id=${id} concurrency=${concurrency}`);
    for (;;) {
      await maintenance();
      let claimed: Job[] = [];
      const free = concurrency - running.size;
      if (free > 0) {
        try { claimed = await withSystem((db) => claimJobs(db, id, free)); }
        catch (e) { log(`claim error: ${(e as Error).message}`); }
        for (const j of claimed) {
          const p = runClaimedJob(j, log).catch(() => {}).finally(() => running.delete(p));
          running.add(p);
        }
      }
      if (claimed.length === 0 || running.size >= concurrency) {
        await Promise.race([new Promise((r) => setTimeout(r, pollMs)), ...(running.size >= concurrency ? Array.from(running) : [])]);
      }
    }
  }
  void loop().catch((e) => { log(`loop crashed: ${(e as Error).message}`); g.__rsiWorkerStarted = false; });
}
