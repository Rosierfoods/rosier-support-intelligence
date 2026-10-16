import './_env';
import { getPool, withSystem } from '../src/lib/db';
import { decryptJson } from '../src/lib/crypto';

const mask = (s: string) => s.replace(/(token|key|signature|sig|expires|X-Amz-[A-Za-z]+|Policy|Key-Pair-Id)=[^&"\s]+/gi, '$1=***').replace(/[0-9a-f]{24,}/gi, '***');
async function probe(label: string, url: string, init?: RequestInit) {
  try {
    const r = await fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const ct = r.headers.get('content-type') ?? '';
    const body = ct.includes('json') || ct.includes('text') ? (await r.text()).slice(0, 300) : `[${ct}, ${r.headers.get('content-length') ?? '?'} bytes]`;
    console.log(`${label}: HTTP ${r.status} · ${ct}\n   ${mask(body)}`);
  } catch (e) { console.log(`${label}: ERROR ${(e as Error).message}`); }
}
(async () => {
  const c = await withSystem((db) => db.one(`SELECT config, secrets_enc FROM integration_connections WHERE provider='myoperator'`));
  const token = (decryptJson<Record<string, string>>(c.secrets_enc).apiToken ?? '').trim();
  const base = (c.config?.apiBaseUrl || 'https://developers.myoperator.co').replace(/\/+$/, '');
  const res = await fetch(`${base}/search`, { method: 'POST', body: new URLSearchParams({ token, page_size: '100', log_from: '0' }) });
  const hits = ((await res.json())?.data?.hits ?? []).map((h: any) => h._source ?? h);
  const doc = hits.find((d: any) => d.filename || d.fileurl);
  if (!doc) { console.log('No recent call has a recording file name or URL in MyOperator (checked', hits.length, 'calls).'); await getPool().end(); return; }
  const fileurl = String(doc.fileurl ?? ''); const filename = String(doc.filename ?? '');
  let host = ''; try { host = new URL(fileurl).host; } catch { /* empty */ }
  console.log('Sample call → filename present:', !!filename, '· fileurl host:', host || '(none)', '· fileurl has query string:', fileurl.includes('?'));
  if (fileurl) {
    await probe('A  fileurl as given', fileurl);
    await probe('B  fileurl + token', fileurl + (fileurl.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token));
  }
  if (filename) {
    await probe('C  GET  /recordings/link', `${base}/recordings/link?token=${encodeURIComponent(token)}&file=${encodeURIComponent(filename)}`);
    await probe('D  POST /recordings/link', `${base}/recordings/link`, { method: 'POST', body: new URLSearchParams({ token, file: filename }) });
    await probe('E  POST /recordings/link (filename)', `${base}/recordings/link`, { method: 'POST', body: new URLSearchParams({ token, filename }) });
  }
  await getPool().end();
})().catch((e) => { console.error(e.message); process.exit(1); });
