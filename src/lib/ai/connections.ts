import type { Db } from '@/lib/db';
import { decryptJson } from '@/lib/crypto';
import { PipelineError } from './errors';

export interface LoadedConnection {
  id: string;
  orgId: string;
  provider: string;
  status: string;
  config: Record<string, any>;
  secrets: Record<string, string>;
}

const LABELS: Record<string, string> = { anthropic: 'Claude (Anthropic)', sarvam: 'Sarvam speech-to-text' };

/**
 * Load + decrypt an org's integration connection. Works in org context (RLS confines to app.org_id)
 * or system context (pass orgId explicitly). Returns null when not configured; never logs secrets.
 * A connection counts as usable when it has secrets and status is 'connected' or 'configured'.
 */
export async function findProviderConnection(db: Db, providerId: string, orgId?: string): Promise<LoadedConnection | null> {
  const row = await db.one<any>(
    `SELECT id, org_id, provider, status, config, secrets_enc FROM integration_connections
      WHERE provider = $1 ${orgId ? 'AND org_id = $2' : ''} LIMIT 1`, orgId ? [providerId, orgId] : [providerId]);
  if (!row || !row.secrets_enc || !['connected', 'configured'].includes(row.status)) return null;
  let secrets: Record<string, string>;
  try { secrets = decryptJson<Record<string, string>>(row.secrets_enc); } catch {
    throw new PipelineError(`${LABELS[providerId] ?? providerId} credentials could not be decrypted (was SECRETS_ENCRYPTION_KEY changed?). Re-enter them on the Integrations page.`, { retryable: false });
  }
  return { id: row.id, orgId: row.org_id, provider: row.provider, status: row.status, config: row.config ?? {}, secrets };
}

/** Same as findProviderConnection but throws a clear, user-facing error when not connected. */
export async function getProviderConnection(db: Db, providerId: string, orgId?: string): Promise<LoadedConnection> {
  const c = await findProviderConnection(db, providerId, orgId);
  if (!c) {
    const what = LABELS[providerId] ?? providerId;
    throw new PipelineError(`${what} is not connected. Connect it on the Integrations page.`, { retryable: true, retryAfterMs: 30 * 60_000 });
  }
  return c;
}

/** Record a provider runtime error on the connection card (sync health) without failing the caller. */
export async function noteConnectionError(db: Db, connectionId: string, message: string) {
  try {
    await db.exec(`UPDATE integration_connections SET last_error = $2, last_error_at = now() WHERE id = $1`, [connectionId, message.slice(0, 500)]);
  } catch { /* best effort */ }
}
