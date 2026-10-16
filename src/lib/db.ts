import { Pool, type PoolClient, type QueryResultRow } from 'pg';

/**
 * Database access.
 *
 * - withOrg(): every user-facing request. Runs in a transaction as the `rsi_app` role with
 *   app.org_id set, so Postgres row-level security confines reads and writes to one organisation.
 * - withSystem(): trusted system code only (login lookup, webhook routing, the worker, migrations).
 */

declare global {

  var __rsiPool: Pool | undefined;
}

function makePool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. See .env.example.');
  const sslMode = process.env.DATABASE_SSL; // 'require' | 'no-verify' | undefined
  return new Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    ssl: sslMode === 'require' ? { rejectUnauthorized: true } : sslMode === 'no-verify' ? { rejectUnauthorized: false } : undefined,
  });
}

export function getPool(): Pool {
  if (!global.__rsiPool) global.__rsiPool = makePool();
  return global.__rsiPool;
}

export interface Db {
  query<T extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string, params?: unknown[]): Promise<number>;
  client: PoolClient;
}

function wrap(client: PoolClient): Db {
  return {
    client,
    async query(sql, params) {
      const r = await client.query(sql, params as any[]);
      return r.rows;
    },
    async one(sql, params) {
      const r = await client.query(sql, params as any[]);
      return (r.rows[0] as any) ?? null;
    },
    async exec(sql, params) {
      const r = await client.query(sql, params as any[]);
      return r.rowCount ?? 0;
    },
  };
}

async function tx<T>(setup: (c: PoolClient) => Promise<void>, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await setup(client);
    const result = await fn(wrap(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function withOrg<T>(orgId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(orgId)) throw new Error('Invalid organisation id');
  return tx(async (c) => {
    await c.query('SET LOCAL ROLE rsi_app');
    await c.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
  }, fn);
}

export function withSystem<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return tx(async () => {}, fn);
}

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}
