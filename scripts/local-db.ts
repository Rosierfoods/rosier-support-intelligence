/**
 * Starts a local PostgreSQL 17 server for development/demo without Docker.
 * Data lives in ./.pgdata. Leave this running in its own terminal.
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/rsi
 * For Supabase (local CLI or hosted) skip this and point DATABASE_URL at Supabase instead.
 */
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve('.pgdata');
const port = Number(process.env.LOCAL_DB_PORT ?? 54329);

async function main() {
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: true });
  const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) await pg.createDatabase('rsi');
  console.log(`\n  Local Postgres running on 127.0.0.1:${port}`);
  console.log(`  DATABASE_URL=postgres://postgres:postgres@127.0.0.1:${port}/rsi\n  Press Ctrl+C to stop.\n`);
  const stop = async () => { await pg.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
main().catch((e) => { console.error(e); process.exit(1); });
