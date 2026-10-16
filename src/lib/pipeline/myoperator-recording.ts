/** MyOperator recording access: panel fileurl is 403 by API; get a fresh S3 link from GET /recordings/link. */
import type { RecordingFetchArgs } from './transcribe';
import { PipelineError } from '@/lib/ai/errors';
import { networkReason } from '@/lib/providers/anthropic';
import { decryptJson } from '@/lib/crypto';

// ───────────────────────── MyOperator recordings ─────────────────────────
// The panel `fileurl` (app.myoperator.com) is not downloadable by API (403). A fresh, short-lived S3 link is obtained
// from GET {base}/recordings/link?token=<Calling API token>&file=<filename>  →  { status:'success', url }.
const MYOP_DEFAULT_BASE = 'https://developers.myoperator.co';

export function myOperatorFileName(ref: string | null | undefined): string | null {
  const r = (ref ?? '').trim();
  if (!r) return null;
  if (r.startsWith('myoperator-file:')) return r.slice('myoperator-file:'.length).trim() || null;
  if (/^https?:\/\//i.test(r)) {
    try {
      const u = new URL(r);
      if (/amazonaws\.com$/i.test(u.hostname)) return null; // already a direct link
      const q = u.searchParams.get('file') ?? u.searchParams.get('filename');
      if (q) return q;
      const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
      return /\.(mp3|wav|ogg|m4a|amr|gsm)$/i.test(last) ? last : null;
    } catch { return null; }
  }
  return r;
}

export async function resolveMyOperatorRecording(a: RecordingFetchArgs): Promise<{ url: string; init?: RequestInit }> {
  if (/^https?:\/\/[^/]*amazonaws\.com\//i.test(a.ref)) return { url: a.ref };
  const row = await a.db.one<{ config: any; secrets_enc: string | null }>(
    `SELECT config, secrets_enc FROM integration_connections WHERE provider = 'myoperator' ${a.connectionId ? 'AND id = $1' : ''} ORDER BY updated_at DESC LIMIT 1`,
    a.connectionId ? [a.connectionId] : []);
  const token = (decryptJson<Record<string, string>>(row?.secrets_enc).apiToken ?? '').trim();
  if (!token) throw new PipelineError('MyOperator Calling API token is not saved, so the recording link cannot be requested.', { retryable: false });
  const base = String(row?.config?.apiBaseUrl || MYOP_DEFAULT_BASE).trim().replace(/\/+$/, '');

  const names: string[] = [];
  const fromRef = myOperatorFileName(a.ref);
  if (fromRef) names.push(fromRef);
  const tried: string[] = [];
  for (let i = 0; i < 2; i++) {
    for (const file of names.splice(0)) {
      if (tried.includes(file)) continue;
      tried.push(file);
      const link = await myOperatorLink(base, token, file);
      if (link) return { url: link };
    }
    if (i === 0 && a.sourceRecordId) {
      const found = await myOperatorFileNameBySearch(base, token, a.sourceRecordId);
      if (found) names.push(found);
    }
  }
  throw new PipelineError('MyOperator did not return a recording link for this call (no recording, or the file has expired).', { retryable: false });
}

async function myOperatorGet(url: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch (e: any) {
    throw new PipelineError(`Could not reach MyOperator for the recording link (${networkReason(e)}).`, { retryable: true });
  }
  if (res.status === 429) throw new PipelineError('MyOperator rate limit reached while requesting the recording link.', { retryable: true, retryAfterMs: 10 * 60_000 });
  if (res.status >= 500) throw new PipelineError(`MyOperator error ${res.status} while requesting the recording link.`, { retryable: true });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return null; }
}

async function myOperatorLink(base: string, token: string, file: string): Promise<string | null> {
  const u = new URL(`${base}/recordings/link`);
  u.searchParams.set('token', token);
  u.searchParams.set('file', file);
  const j = await myOperatorGet(u.toString());
  const url = j?.url ?? j?.data?.url;
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url;
  const msg = String(j?.message ?? j?.error ?? '');
  if (/not authori[sz]ed|invalid token/i.test(msg)) throw new PipelineError('MyOperator rejected the Calling API token when requesting the recording link.', { retryable: false });
  return null;
}

async function myOperatorFileNameBySearch(base: string, token: string, uniqueId: string): Promise<string | null> {
  const body = new URLSearchParams({ token, search_key: uniqueId, page_size: '5', log_from: '0' });
  const j = await myOperatorGet(`${base}/search`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const hits: any[] = j?.data?.hits ?? [];
  for (const h of hits) {
    const d = h?._source ?? h;
    const uid = (d?.additional_parameters ?? []).find((p: any) => p?.ky === 'unique_id')?.vl;
    if (d?.filename && (!uid || uid === uniqueId || hits.length === 1)) return String(d.filename);
  }
  return null;
}
