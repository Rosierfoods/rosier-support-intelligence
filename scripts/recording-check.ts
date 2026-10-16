import './_env';
import { getPool, withSystem, withOrg } from '../src/lib/db';
import { getRecordingFetchInit } from '../src/lib/pipeline/transcribe';

const mask = (s: string) => s.replace(/(token|signature|X-Amz-[A-Za-z]+|Expires|Policy)=[^&"\s]+/gi, '$1=***');
(async () => {
  const c = await withSystem((db) => db.one<any>(
    `SELECT i.org_id, i.id, i.source_platform, i.connection_id, i.source_record_id, c.recording_source_ref
       FROM processing_jobs j JOIN interactions i ON i.id = j.interaction_id JOIN calls c ON c.interaction_id = i.id
      WHERE j.type = 'transcribe' ORDER BY j.updated_at DESC LIMIT 1`));
  if (!c) { console.log('No transcribe job found.'); return; }
  let refShape = String(c.recording_source_ref ?? '');
  try { const u = new URL(refShape); refShape = `${u.host}  …/${u.pathname.split('/').pop()}${u.search ? '  (has ?query)' : ''}`; } catch { /* not a URL */ }
  console.log('1. Stored recording ref:', refShape);
  console.log('   unique_id saved:', c.source_record_id ? 'yes' : 'NO');
  let target: { url: string; init?: RequestInit };
  try {
    target = await withOrg(c.org_id, (db) => getRecordingFetchInit({ db, orgId: c.org_id, connectionId: c.connection_id, sourcePlatform: c.source_platform, ref: c.recording_source_ref, sourceRecordId: c.source_record_id }));
  } catch (e) { console.log('2. Getting link FAILED:', (e as Error).message); return; }
  const u = new URL(target.url);
  console.log('2. Link from MyOperator:', u.host, '· signed:', /X-Amz-Signature|Signature=/i.test(u.search) ? 'yes' : 'no');
  const r = await fetch(target.url, { ...target.init, redirect: 'follow', signal: AbortSignal.timeout(60000) });
  const ct = r.headers.get('content-type') ?? '';
  const body = r.ok ? `${(await r.arrayBuffer()).byteLength} bytes` : mask((await r.text()).slice(0, 300));
  console.log(`3. Download: HTTP ${r.status} · ${ct} · ${body}`);
})().catch((e) => console.log('ERROR', e.message)).finally(() => getPool().end());
