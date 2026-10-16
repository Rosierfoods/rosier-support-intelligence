/**
 * Integration connection service: CRUD, credential storage, testing, status transitions.
 *
 * Rules:
 *  - Secrets are stored only as AES-256-GCM ciphertext (secrets_enc) and never returned: views carry masked values.
 *  - Blank secret inputs keep the saved value; "clear" must be explicit.
 *  - Status: 'configured' after saving credentials; 'connected' ONLY after a successful test (or a verified signed
 *    webhook for webhook-only setups); 'error' after a failed test/sync; 'disconnected' clears secrets and stops sync.
 *  - Every change is audited without secret values.
 *
 * Functions take a Db already scoped to the organisation (withOrg) and an Actor for auditing. They do not import
 * the session module, so they can be used from scripts and the worker as well as server actions.
 */
import type { Db } from '@/lib/db';
import { withSystem } from '@/lib/db';
import { audit } from '@/lib/audit';
import { decryptJson, encryptJson, maskSecret, randomToken } from '@/lib/crypto';
import { getProvider, PROVIDERS } from '@/lib/providers/registry';
import type { ProviderContext, ProviderDefinition, TestResult } from '@/lib/providers/types';
import { errorMessage } from '@/lib/providers/http';
import { enqueue } from '@/lib/pipeline/jobs';

export interface Actor { orgId: string; userId: string | null; ip?: string; userAgent?: string }

export interface ConnectionRow {
  id: string; org_id: string; provider: string; display_name: string; status: string; config: Record<string, any>;
  secrets_enc: string | null; webhook_path_token: string | null; webhook_verified_at: Date | null; scopes: any;
  sync_enabled: boolean; sync_frequency_minutes: number; historical_from: string | Date | null; checkpoint: Record<string, any>;
  last_tested_at: Date | null; last_test_ok: boolean | null; last_test_message: string | null; last_sync_at: Date | null;
  last_success_at: Date | null; last_error: string | null; last_error_at: Date | null; token_expires_at: Date | null;
  created_at: Date; updated_at: Date;
}

/** Browser-safe view of a connection. */
export interface ConnectionView {
  provider: string;
  id: string | null;
  status: 'disconnected' | 'configured' | 'connected' | 'error' | 'paused';
  config: Record<string, string>;
  secrets: Record<string, { saved: boolean; masked: string }>;
  oauthAuthorized: boolean;
  accountEmail: string | null;
  webhookUrl: string | null;
  webhookVerifiedAt: string | null;
  lastTestedAt: string | null; lastTestOk: boolean | null; lastTestMessage: string | null;
  lastSyncAt: string | null; lastSuccessAt: string | null; lastError: string | null; lastErrorAt: string | null;
  syncEnabled: boolean; syncFrequencyMinutes: number; historicalFrom: string | null; tokenExpiresAt: string | null;
}

export const SYNC_FREQUENCIES = [5, 15, 30, 60, 180, 360, 720, 1440];
const MAX_TEST_MS = 30_000;

export function appUrl(): string {
  return (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
}
export function webhookUrlFor(provider: string, token: string | null): string | null {
  return token ? `${appUrl()}/api/webhooks/${provider}/${token}` : null;
}
export function oauthRedirectUri(provider: string): string {
  return `${appUrl()}/api/oauth/${provider}/callback`;
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export async function getConnectionRow(db: Db, orgId: string, provider: string): Promise<ConnectionRow | null> {
  return db.one<ConnectionRow>('SELECT * FROM integration_connections WHERE org_id = $1 AND provider = $2', [orgId, provider]);
}

export function toView(p: ProviderDefinition, row: ConnectionRow | null): ConnectionView {
  let secrets: Record<string, string> = {};
  if (row?.secrets_enc) {
    try { secrets = decryptJson(row.secrets_enc); } catch { secrets = {}; }
  }
  const config: Record<string, string> = {};
  for (const f of p.configFields) {
    const v = row?.config?.[f.key];
    if (v !== undefined && v !== null) config[f.key] = String(v);
  }
  const masked: ConnectionView['secrets'] = {};
  for (const f of p.secretFields) masked[f.key] = { saved: !!secrets[f.key], masked: maskSecret(secrets[f.key]) };
  return {
    provider: p.id,
    id: row?.id ?? null,
    status: (row?.status as ConnectionView['status']) ?? 'disconnected',
    config,
    secrets: masked,
    oauthAuthorized: !!secrets.refreshToken,
    accountEmail: row?.config?.accountEmail ? String(row.config.accountEmail) : null,
    webhookUrl: p.supportsWebhook ? webhookUrlFor(p.id, row?.webhook_path_token ?? null) : null,
    webhookVerifiedAt: iso(row?.webhook_verified_at),
    lastTestedAt: iso(row?.last_tested_at), lastTestOk: row?.last_test_ok ?? null, lastTestMessage: row?.last_test_message ?? null,
    lastSyncAt: iso(row?.last_sync_at), lastSuccessAt: iso(row?.last_success_at), lastError: row?.last_error ?? null, lastErrorAt: iso(row?.last_error_at),
    syncEnabled: !!row?.sync_enabled, syncFrequencyMinutes: row?.sync_frequency_minutes ?? 30,
    historicalFrom: row?.historical_from ? iso(row.historical_from)!.slice(0, 10) : null,
    tokenExpiresAt: iso(row?.token_expires_at),
  };
}

export async function listConnectionViews(db: Db, orgId: string): Promise<ConnectionView[]> {
  const rows = await db.query<ConnectionRow>('SELECT * FROM integration_connections WHERE org_id = $1', [orgId]);
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return PROVIDERS.map((p) => toView(p, byProvider.get(p.id) ?? null));
}

/** Decrypted provider context. Server-side only. updateSecrets persists in its own transaction. */
export function buildContext(row: ConnectionRow): ProviderContext {
  const secrets: Record<string, string> = row.secrets_enc ? decryptJson(row.secrets_enc) : {};
  return {
    orgId: row.org_id,
    connectionId: row.id,
    config: { ...(row.config ?? {}) },
    secrets,
    appUrl: appUrl(),
    updateSecrets: async (patch, tokenExpiresAt) => {
      Object.assign(secrets, patch);
      await withSystem(async (db) => {
        const cur = await db.one<{ secrets_enc: string | null }>('SELECT secrets_enc FROM integration_connections WHERE id = $1 FOR UPDATE', [row.id]);
        const merged = { ...(cur?.secrets_enc ? decryptJson(cur.secrets_enc) : {}), ...patch };
        await db.exec('UPDATE integration_connections SET secrets_enc = $2, token_expires_at = coalesce($3, token_expires_at) WHERE id = $1',
          [row.id, encryptJson(merged), tokenExpiresAt ?? null]);
      });
    },
  };
}

async function log(db: Db, actor: Actor, action: string, connectionId: string | null, details: Record<string, unknown>) {
  await audit(db, actor.orgId, actor.userId, action, 'integration_connection', connectionId, details, { ip: actor.ip, userAgent: actor.userAgent });
}

export interface SaveInput {
  config?: Record<string, unknown>;
  secrets?: Record<string, string | null | undefined>;
  clearSecrets?: string[];
  syncFrequencyMinutes?: number;
  historicalFrom?: string | null;
}

export class ValidationError extends Error {}

function cleanConfig(p: ProviderDefinition, input: Record<string, unknown>, existing: Record<string, any>): { config: Record<string, any>; changed: string[] } {
  const config: Record<string, any> = { ...existing };
  const changed: string[] = [];
  for (const f of p.configFields) {
    if (!(f.key in input)) continue;
    let v = input[f.key] === undefined || input[f.key] === null ? '' : String(input[f.key]).trim();
    if (v.length > 500) throw new ValidationError(`${f.label} is too long.`);
    if (v && f.type === 'url') {
      try {
        const u = new URL(v);
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) throw new Error();
        v = v.replace(/\/+$/, '');
      } catch { throw new ValidationError(`${f.label} must be a valid https:// URL.`); }
    }
    if (v && f.type === 'number' && !Number.isFinite(Number(v))) throw new ValidationError(`${f.label} must be a number.`);
    if (v && f.type === 'select' && f.options && !f.options.some((o) => o.value === v)) throw new ValidationError(`${f.label}: invalid option.`);
    const prev = existing[f.key] === undefined || existing[f.key] === null ? '' : String(existing[f.key]);
    if (v !== prev) changed.push(f.key);
    if (v) config[f.key] = f.type === 'number' ? Number(v) : v;
    else delete config[f.key];
  }
  return { config, changed };
}

export async function saveConnection(db: Db, actor: Actor, providerId: string, input: SaveInput): Promise<ConnectionRow> {
  const p = getProvider(providerId);
  if (!p) throw new ValidationError('Unknown provider');
  const row = await getConnectionRow(db, actor.orgId, providerId);
  const { config, changed } = cleanConfig(p, input.config ?? {}, row?.config ?? {});

  let secrets: Record<string, string> = row?.secrets_enc ? decryptJson(row.secrets_enc) : {};
  const secretChanged: string[] = [];
  const allowed = new Set(p.secretFields.map((f) => f.key));
  for (const [k, v] of Object.entries(input.secrets ?? {})) {
    if (!allowed.has(k)) continue;
    const val = (v ?? '').trim();
    if (!val) continue; // blank = keep existing
    if (val.length > 8000) throw new ValidationError('Credential value is too long.');
    if (secrets[k] !== val) { secrets[k] = val; secretChanged.push(k); }
  }
  for (const k of input.clearSecrets ?? []) {
    if (allowed.has(k) && secrets[k]) { delete secrets[k]; secretChanged.push(k); }
  }
  // OAuth client changes invalidate previously granted tokens.
  if (p.authType === 'oauth2' && (changed.includes('clientId') || changed.includes('tenant') || secretChanged.includes('clientSecret'))) {
    delete secrets.accessToken; delete secrets.refreshToken; delete secrets.accessTokenExpiresAt;
  }
  const freq = input.syncFrequencyMinutes !== undefined ? Number(input.syncFrequencyMinutes) : row?.sync_frequency_minutes ?? 30;
  if (!SYNC_FREQUENCIES.includes(freq)) throw new ValidationError('Invalid sync frequency.');
  let historicalFrom: string | null = row?.historical_from ? new Date(row.historical_from).toISOString().slice(0, 10) : null;
  if (input.historicalFrom !== undefined) {
    if (input.historicalFrom && !/^\d{4}-\d{2}-\d{2}$/.test(input.historicalFrom)) throw new ValidationError('Historical import date must be YYYY-MM-DD.');
    if (input.historicalFrom && new Date(input.historicalFrom) > new Date()) throw new ValidationError('Historical import date cannot be in the future.');
    historicalFrom = input.historicalFrom || null;
  }

  const credentialsChanged = changed.length > 0 || secretChanged.length > 0;
  const hasAnything = Object.keys(secrets).length > 0 || Object.keys(config).length > 0;
  let status = row?.status ?? 'disconnected';
  if (credentialsChanged || (status === 'disconnected' && hasAnything)) status = hasAnything ? 'configured' : 'disconnected';
  const webhookToken = p.supportsWebhook ? row?.webhook_path_token ?? randomToken(24) : null;
  const secretsEnc = Object.keys(secrets).length ? encryptJson(secrets) : null;

  let saved: ConnectionRow | null;
  if (!row) {
    saved = await db.one<ConnectionRow>(
      `INSERT INTO integration_connections (org_id, provider, display_name, status, config, secrets_enc, webhook_path_token, scopes,
                                            sync_frequency_minutes, historical_from, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [actor.orgId, p.id, p.name, status, JSON.stringify(config), secretsEnc, webhookToken, JSON.stringify(p.scopes.map((s) => s.key)),
        freq, historicalFrom, actor.userId]);
  } else {
    saved = await db.one<ConnectionRow>(
      `UPDATE integration_connections SET status = $2, config = $3, secrets_enc = $4, webhook_path_token = $5, sync_frequency_minutes = $6,
              historical_from = $7, scopes = $8,
              sync_enabled = CASE WHEN $2 IN ('connected','error') THEN sync_enabled ELSE false END
        WHERE id = $1 RETURNING *`,
      [row.id, status, JSON.stringify(config), secretsEnc, webhookToken, freq, historicalFrom, JSON.stringify(p.scopes.map((s) => s.key))]);
  }
  if (!saved) throw new Error('Could not save connection');
  await log(db, actor, 'integration.configured', saved.id, {
    provider: p.id, config_fields_changed: changed, secret_fields_changed: secretChanged, status, sync_frequency_minutes: freq, historical_from: historicalFrom,
  });
  return saved;
}

/** Run the provider's test. Marks 'connected' only on success. */
export async function testConnection(db: Db, actor: Actor, providerId: string): Promise<TestResult> {
  const p = getProvider(providerId);
  if (!p) throw new ValidationError('Unknown provider');
  const row = await getConnectionRow(db, actor.orgId, providerId);
  if (!row || row.status === 'disconnected') return { ok: false, message: 'Save the configuration first.' };
  let result: TestResult;
  try {
    const ctx = buildContext(row);
    result = await Promise.race([
      p.testConnection(ctx),
      new Promise<TestResult>((resolve) => setTimeout(() => resolve({ ok: false, message: `Test timed out after ${MAX_TEST_MS / 1000}s.` }), MAX_TEST_MS)),
    ]);
  } catch (e) {
    result = { ok: false, message: errorMessage(e) };
  }
  const message = String(result.message ?? '').slice(0, 500);
  const pending = !result.ok && !!(result.details as any)?.pending;
  const status = result.ok ? 'connected' : pending && row.status !== 'connected' ? 'configured' : 'error';
  const account = typeof (result.details as any)?.account === 'string' ? String((result.details as any).account) : null;
  await db.exec(
    `UPDATE integration_connections SET status = $2, last_tested_at = now(), last_test_ok = $3, last_test_message = $4,
            config = CASE WHEN $5::text IS NOT NULL THEN config || jsonb_build_object('accountEmail', $5::text) ELSE config END,
            last_error = CASE WHEN $2 = 'error' THEN $4 ELSE last_error END, last_error_at = CASE WHEN $2 = 'error' THEN now() ELSE last_error_at END,
            sync_enabled = CASE WHEN $2 IN ('connected','error') THEN sync_enabled ELSE false END
      WHERE id = $1`,
    [row.id, status, result.ok, message, account]);
  await log(db, actor, 'integration.tested', row.id, { provider: p.id, ok: result.ok, message });
  return { ok: result.ok, message };
}

export async function setSyncEnabled(db: Db, actor: Actor, providerId: string, enabled: boolean): Promise<void> {
  const p = getProvider(providerId);
  const row = await getConnectionRow(db, actor.orgId, providerId);
  if (!p || !row) throw new ValidationError('Connection not found');
  if (enabled && !p.supportsPolling) throw new ValidationError(`${p.name} does not support scheduled sync.`);
  if (enabled && row.status !== 'connected') throw new ValidationError('Test the connection successfully before enabling sync.');
  await db.exec('UPDATE integration_connections SET sync_enabled = $2 WHERE id = $1', [row.id, enabled]);
  await log(db, actor, enabled ? 'integration.sync_enabled' : 'integration.sync_disabled', row.id, { provider: p.id });
}

/** Syncing needs a connection that has passed a test; 'error' counts only if it has synced successfully before. */
export function canSync(row: Pick<ConnectionRow, 'status' | 'last_success_at'>): boolean {
  return row.status === 'connected' || (row.status === 'error' && !!row.last_success_at);
}

export async function requestSync(db: Db, actor: Actor, providerId: string, kind: 'sync' | 'historical_import', from?: string | null): Promise<{ queued: boolean; message: string }> {
  const p = getProvider(providerId);
  const row = await getConnectionRow(db, actor.orgId, providerId);
  if (!p || !row) throw new ValidationError('Connection not found');
  if (!p.supportsPolling || !p.fetchSince) throw new ValidationError(`${p.name} receives data by webhook only; there is nothing to sync on demand.`);
  if (!canSync(row)) throw new ValidationError('Test the connection successfully first.');
  if (kind === 'historical_import') {
    const date = from || (row.historical_from ? new Date(row.historical_from).toISOString().slice(0, 10) : null);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError('Choose a historical import start date.');
    if (new Date(date) > new Date()) throw new ValidationError('Historical import date cannot be in the future.');
    await db.exec(`UPDATE integration_connections SET historical_from = $2, checkpoint = checkpoint - 'historical' WHERE id = $1`, [row.id, date]);
    const id = await enqueue(db, actor.orgId, 'historical_import', { connectionId: row.id, dedupeKey: `historical:${row.id}`, payload: { from: date, trigger: 'historical' }, priority: 120 });
    await log(db, actor, 'integration.historical_import_requested', row.id, { provider: p.id, from: date, queued: !!id });
    return { queued: !!id, message: id ? `Historical import from ${date} queued.` : 'A historical import is already queued or running.' };
  }
  const id = await enqueue(db, actor.orgId, 'sync', { connectionId: row.id, dedupeKey: `sync:${row.id}`, payload: { trigger: 'manual' }, priority: 80 });
  await log(db, actor, 'integration.sync_requested', row.id, { provider: p.id, queued: !!id });
  return { queued: !!id, message: id ? 'Sync queued — results appear below within a minute (requires the background worker).' : 'A sync is already queued or running.' };
}

export async function disconnect(db: Db, actor: Actor, providerId: string): Promise<void> {
  const row = await getConnectionRow(db, actor.orgId, providerId);
  if (!row) return;
  await db.exec(
    `UPDATE integration_connections SET status = 'disconnected', secrets_enc = NULL, sync_enabled = false, token_expires_at = NULL,
            webhook_path_token = NULL, webhook_verified_at = NULL, last_test_ok = NULL, last_test_message = NULL,
            config = config - 'accountEmail'
      WHERE id = $1`, [row.id]);
  await db.exec(`UPDATE processing_jobs SET status = 'cancelled', finished_at = now() WHERE connection_id = $1 AND status = 'queued'`, [row.id]);
  await log(db, actor, 'integration.disconnected', row.id, { provider: providerId });
}

/** Store OAuth tokens after a successful code exchange (encrypted), keeping client credentials. */
export async function storeOAuthTokens(db: Db, actor: Actor, providerId: string, tokens: Record<string, string>, expiresAt: Date | null | undefined, account?: string): Promise<void> {
  const row = await getConnectionRow(db, actor.orgId, providerId);
  if (!row) throw new ValidationError('Connection not found');
  const secrets = { ...(row.secrets_enc ? decryptJson(row.secrets_enc) : {}), ...tokens };
  await db.exec(
    `UPDATE integration_connections SET secrets_enc = $2, token_expires_at = $3, status = 'configured',
            config = CASE WHEN $4::text IS NOT NULL THEN config || jsonb_build_object('accountEmail', $4::text) ELSE config END
      WHERE id = $1`, [row.id, encryptJson(secrets), expiresAt ?? null, account ?? null]);
  await log(db, actor, 'integration.oauth_authorized', row.id, { provider: providerId, account: account ?? null });
}

/**
 * A verified, signed webhook proves the inbound path works. Record it, and promote a 'configured' connection
 * to 'connected' (system context; called by the webhook route).
 */
export async function markWebhookVerified(db: Db, connectionId: string, providerName: string, promote = true): Promise<void> {
  await db.exec(
    `UPDATE integration_connections SET
        webhook_verified_at = coalesce(webhook_verified_at, now()),
        status = CASE WHEN $3 AND status = 'configured' THEN 'connected' ELSE status END,
        last_test_ok = CASE WHEN $3 AND status = 'configured' THEN true ELSE last_test_ok END,
        last_tested_at = CASE WHEN $3 AND status = 'configured' THEN now() ELSE last_tested_at END,
        last_test_message = CASE WHEN $3 AND status = 'configured' THEN $2 ELSE last_test_message END,
        last_error = CASE WHEN $3 AND status = 'configured' THEN NULL ELSE last_error END
      WHERE id = $1`, [connectionId, `Verified by an authenticated webhook from ${providerName}.`, promote]);
}
