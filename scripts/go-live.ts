/**
 * Switch from demo to real data in one step:
 *   1. imports recent calls from the connected MyOperator account (default: last 2 days)
 *   2. turns on scheduled sync (every 30 min) so new calls keep arriving
 *   3. removes all DEMO DATA (demo calls, chats, emails, demo users)
 *   4. creates your own Super Admin login and prints a one-time password
 * Usage: npx tsx scripts/go-live.ts --email you@company.com --name "Your Name" [--days 2] [--keep-demo]
 */
import './_env';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { getPool, withSystem } from '../src/lib/db';
import { runIntegrationJob } from '../src/lib/integrations/sync';
import { clearDemoData } from '../src/lib/demo/generate';

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };

async function main() {
  const email = (arg('email') ?? '').toLowerCase();
  const name = arg('name') ?? email;
  const days = Math.max(1, Math.min(30, Number(arg('days') ?? 2)));
  if (!email.includes('@')) { console.error('Add your email: --email you@company.com'); process.exit(1); }

  const conn = await withSystem((db) => db.one<{ id: string; org_id: string; status: string }>(
    `SELECT id, org_id, status FROM integration_connections WHERE provider = 'myoperator'`));
  if (!conn) { console.error('MyOperator is not set up on the Integrations page yet.'); process.exit(1); }
  if (conn.status !== 'connected' && conn.status !== 'error') {
    console.error(`MyOperator status is "${conn.status}". Click "Test connection" on the MyOperator card until it says reachable, then run this again.`);
    process.exit(1);
  }

  await withSystem((db) => db.exec(`UPDATE integration_connections SET sync_enabled = true, sync_frequency_minutes = 30 WHERE id = $1`, [conn.id]));
  const from = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  console.log(`1/3  Importing MyOperator calls since ${from} … (MyOperator allows ~20 requests/min, so this can take a few minutes)`);
  try {
    await runIntegrationJob(null as any, {
      id: 'go-live', org_id: conn.org_id, type: 'historical_import', interaction_id: null, connection_id: conn.id,
      payload: { from, trigger: 'manual' }, attempts: 1, max_attempts: 1,
    } as any);
  } catch (e) {
    console.error('     Import stopped early:', (e as Error).message);
  }
  const run = await withSystem((db) => db.one(`SELECT status, records_fetched, records_created, records_duplicate, error FROM integration_sync_runs WHERE connection_id = $1 ORDER BY started_at DESC LIMIT 1`, [conn.id]));
  const real = await withSystem((db) => db.one<{ c: number }>(`SELECT count(*)::int AS c FROM interactions WHERE org_id = $1 AND NOT is_demo`, [conn.org_id]));
  console.log(`     Run: ${run?.status} · fetched ${run?.records_fetched} · new ${run?.records_created} · already had ${run?.records_duplicate}${run?.error ? ` · note: ${run.error}` : ''}`);
  console.log(`     Real interactions now stored: ${real?.c}`);

  const password = randomBytes(9).toString('base64url') + '7a';
  await withSystem(async (db) => {
    await db.exec(
      `INSERT INTO users (org_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,'super_admin')
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'super_admin', is_active = true, is_demo = false, failed_login_count = 0, locked_until = NULL`,
      [conn.org_id, email, name, await bcrypt.hash(password, 12)]);
  });
  console.log(`2/3  Your login is ready: ${email}`);

  if (process.argv.includes('--keep-demo')) {
    console.log('3/3  Demo data kept (--keep-demo).');
  } else {
    await withSystem(async (db) => {
      await db.query("SELECT set_config('app.org_id', $1, true)", [conn.org_id]);
      await clearDemoData(db, conn.org_id);
      await db.exec(`INSERT INTO audit_logs (org_id, action, target_type, details) VALUES ($1,'demo.cleared_cli','organization','{"via":"go-live"}')`, [conn.org_id]);
    });
    console.log('3/3  Demo data removed.');
  }
  console.log(`\n  Sign in at the website with:\n    Email:    ${email}\n    Password: ${password}\n  (Change it under Profile & security.)\n`);
  console.log('  Keep "npm run worker" running so new calls sync every 30 minutes.');
  await getPool().end();
}
main().catch((e) => { console.error(e); process.exit(1); });
