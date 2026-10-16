/**
 * Inbound webhook intake: route by path token → verify → store (deduplicated) → enqueue processing → ack fast.
 * Runs in system context because the organisation is only known after the token lookup.
 */
import { withSystem } from '@/lib/db';
import { sha256Hex } from '@/lib/crypto';
import { enqueue } from '@/lib/pipeline/jobs';
import { getProvider } from '@/lib/providers/registry';
import { errorMessage } from '@/lib/providers/http';
import type { NormalizedInteraction } from '@/lib/providers/types';
import { buildContext, markWebhookVerified, type ConnectionRow } from './connections';

export const MAX_WEBHOOK_BYTES = 1024 * 1024;

const DROP_HEADERS = /^(authorization|cookie|set-cookie|proxy-authorization|x-hub-signature.*|x-chatwoot-signature|x-webhook-signature|x-webhook-token|x-rsi-webhook-key|x-api-key|api_access_token)$/i;

/** Keep headers useful for debugging; drop credentials/signatures (values replaced by a marker). */
export function sanitizeHeaders(h: Record<string, string>, extraSecretHeader?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (DROP_HEADERS.test(key) || (extraSecretHeader && key === extraSecretHeader.toLowerCase())) { out[key] = '[redacted]'; continue; }
    if (['x-forwarded-for', 'x-real-ip'].includes(key)) continue;
    out[key] = String(v).slice(0, 300);
  }
  return out;
}

function sanitizeQuery(q: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) out[k] = /^(key|token|hub\.verify_token)$/i.test(k) ? '[redacted]' : String(v).slice(0, 300);
  return out;
}

function stripRaw(records: NormalizedInteraction[]): NormalizedInteraction[] {
  return records.map(({ raw: _raw, ...r }) => r);
}

export interface WebhookResponse { status: number; body: string; contentType?: string }

export async function handleIncomingWebhook(input: {
  provider: string; token: string; method: string; headers: Record<string, string>; rawBody: string; query: Record<string, string>;
}): Promise<WebhookResponse> {
  const p = getProvider(input.provider);
  if (!p || !p.supportsWebhook || !p.handleWebhook || !/^[A-Za-z0-9_-]{16,100}$/.test(input.token)) return { status: 404, body: 'Not found' };

  return withSystem(async (db) => {
    const row = await db.one<ConnectionRow>('SELECT * FROM integration_connections WHERE webhook_path_token = $1', [input.token]);
    if (!row || row.provider !== p.id || row.status === 'disconnected' || row.status === 'paused') return { status: 404, body: 'Not found' };

    let result;
    try {
      result = await p.handleWebhook!(buildContext(row), { headers: input.headers, rawBody: input.rawBody, query: input.query, method: input.method });
    } catch (e) {
      return { status: 400, body: `Could not parse webhook: ${errorMessage(e, 200)}` };
    }

    // GET (verification handshake)
    if (input.method === 'GET' && result.response) {
      if (result.verified) await markWebhookVerified(db, row.id, p.name, false);
      return result.response;
    }

    let parsed: any;
    try { parsed = JSON.parse(input.rawBody); } catch { parsed = { raw: input.rawBody.slice(0, 200_000) }; }
    const headers = sanitizeHeaders(input.headers, row.config?.webhookHeader);
    const query = sanitizeQuery(input.query);

    if (!result.verified) {
      await db.exec(
        `INSERT INTO webhook_events (org_id, connection_id, provider, event_key, signature_valid, payload, headers, status, error)
         VALUES ($1,$2,$3,$4,false,$5,$6,'failed','Signature / shared-key verification failed')
         ON CONFLICT (connection_id, event_key) DO NOTHING`,
        [row.org_id, row.id, p.id, `invalid:${sha256Hex(input.rawBody || JSON.stringify(input.query))}`, JSON.stringify({ body: parsed, query }), JSON.stringify(headers)]);
      return { status: 401, body: 'Invalid signature' };
    }

    if (!row.webhook_verified_at || row.status === 'configured') await markWebhookVerified(db, row.id, p.name, true);
    let queued = 0;
    for (const ev of result.events) {
      const records = stripRaw(ev.records);
      const inserted = await db.one<{ id: string }>(
        `INSERT INTO webhook_events (org_id, connection_id, provider, event_key, signature_valid, payload, headers, status)
         VALUES ($1,$2,$3,$4,true,$5,$6,$7)
         ON CONFLICT (connection_id, event_key) DO NOTHING RETURNING id`,
        [row.org_id, row.id, p.id, ev.key.slice(0, 300), JSON.stringify({ body: parsed, query, records }), JSON.stringify(headers), records.length ? 'received' : 'ignored']);
      if (!inserted || !records.length) continue; // duplicate delivery, or nothing importable (e.g. delivery status)
      await enqueue(db, row.org_id, 'webhook_process', { connectionId: row.id, dedupeKey: `webhook:${inserted.id}`, payload: { eventId: inserted.id }, priority: 40 });
      queued++;
    }
    return result.response ?? { status: 200, body: JSON.stringify({ ok: true, queued }), contentType: 'application/json' };
  });
}
