import './_env';
import fs from 'node:fs';
import path from 'node:path';
import { getPool } from '../src/lib/db';

async function main() {
  const pool = getPool();
  const c = await pool.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const dir = path.resolve('db/migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      process.stdout.write(`→ applying ${f} … `);
      await c.query('BEGIN');
      try {
        await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        console.log('ok');
      } catch (e) {
        await c.query('ROLLBACK');
        console.log('FAILED');
        throw e;
      }
    }
    console.log('Migrations up to date.');
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
