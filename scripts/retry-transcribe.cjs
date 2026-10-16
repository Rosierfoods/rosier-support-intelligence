// Re-queue failed call transcriptions. Usage: node scripts/retry-transcribe.cjs [limit]   (default 20; "all" for every call)
require('dotenv').config({ path: '.env.local' });
const { Client } = require('pg');
(async () => {
  const arg = process.argv[2] || '20';
  const limit = arg === 'all' ? null : Math.max(1, parseInt(arg, 10) || 20);
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined });
  await c.connect();
  const r = await c.query(
    `UPDATE processing_jobs SET status = 'queued', attempts = 0, run_after = now(), last_error = NULL
      WHERE id IN (SELECT id FROM processing_jobs WHERE type = 'transcribe' AND status IN ('queued','dead','failed')
                   ORDER BY created_at DESC ${limit ? 'LIMIT ' + limit : ''})`);
  console.log(`Retrying ${r.rowCount} call(s). Keep "npm run worker" running and watch the Calls page.`);
  const s = await c.query(`SELECT status, count(*)::int AS n FROM processing_jobs WHERE type = 'transcribe' GROUP BY 1 ORDER BY 1`);
  console.log('Transcribe jobs now:', s.rows.map((x) => `${x.status}=${x.n}`).join('  '));
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
