import { getStorage } from '@/lib/storage';
import { NextResponse, type NextRequest } from 'next/server';
import { assertPermission, auditAction } from '@/lib/auth/session';
import { isUuid, withOrg } from '@/lib/db';
import { SqlBuilder } from '@/lib/sql';
import { scopeInteractions } from '@/lib/repos/scope';
import { getRecordingFetchInit } from '@/lib/pipeline/transcribe';

// Short-lived provider links (e.g. MyOperator /recordings/link) cached per call so seeking doesn't burn API quota.
const linkCache = new Map<string, { url: string; exp: number }>();

export const dynamic = 'force-dynamic';

/**
 * Authorised recording playback proxy.
 * The browser only ever sees /api/media/<id>; provider URLs and credentials stay server-side.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ interactionId: string }> }) {
  const params = await props.params;
  let s;
  try {
    s = await assertPermission('recordings.play');
  } catch {
    return NextResponse.json({ error: 'You do not have permission to play recordings.' }, { status: 403 });
  }
  const id = params.interactionId;
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const session = s;
  const range = req.headers.get('range');
  // Audit once per playback (the first byte-range request), not for every seek chunk.
  const firstChunk = !range || /^bytes=0-/.test(range);

  const rec = await withOrg(session.org.id, async (db) => {
    const b = new SqlBuilder();
    b.and(`i.id = ${b.p(id)}`);
    b.and(scopeInteractions(session, b, 'i'));
    const row = await db.one<{ ref: string; source_platform: string; connection_id: string | null; source_record_id: string | null; recording_available: boolean; recording_source_ref: string | null; recording_storage_key: string | null; recording_mime: string | null }>(
      `SELECT i.ref, i.source_platform, i.connection_id, i.source_record_id, c.recording_available, c.recording_source_ref, c.recording_storage_key, c.recording_mime
         FROM interactions i JOIN calls c ON c.interaction_id = i.id ${b.whereSql()}`, b.params);
    if (row && row.recording_available && firstChunk) {
      await auditAction(db, session, 'recording.played', 'interaction', id, { ref: row.ref });
    }
    return row;
  });

  if (!rec) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!rec.recording_available) return NextResponse.json({ error: 'No authorised recording is available for this call.' }, { status: 404 });
  if (rec.recording_storage_key) {
    try {
      const obj = await getStorage().stream(rec.recording_storage_key);
      if (!obj) return NextResponse.json({ error: 'The retained recording copy was not found (it may have been removed by the retention policy).' }, { status: 404 });
      const headers = new Headers({
        'Content-Type': obj.contentType ?? rec.recording_mime ?? 'audio/mpeg',
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline',
      });
      if (obj.size) headers.set('Content-Length', String(obj.size));
      return new NextResponse(obj.stream, { status: 200, headers });
    } catch {
      return NextResponse.json({ error: 'Private storage is not reachable. Check STORAGE_DRIVER settings.' }, { status: 502 });
    }
  }
  let ref = rec.recording_source_ref ?? '';
  if (rec.source_platform === 'myoperator' && ref && !ref.startsWith('demo://')) {
    const hit = linkCache.get(id);
    if (hit && hit.exp > Date.now()) ref = hit.url;
    else {
      try {
        const t = await withOrg(session.org.id, (db) => getRecordingFetchInit({
          db, orgId: session.org.id, connectionId: rec.connection_id, sourcePlatform: rec.source_platform, ref, sourceRecordId: rec.source_record_id,
        }));
        ref = t.url;
        linkCache.set(id, { url: ref, exp: Date.now() + 10 * 60_000 });
        if (linkCache.size > 500) linkCache.delete(linkCache.keys().next().value as string);
      } catch (e) {
        return NextResponse.json({ error: `Could not get this recording from MyOperator: ${(e as Error).message}` }, { status: 502 });
      }
    }
  }
  if (ref.startsWith('demo://')) return NextResponse.json({ error: 'Demo recordings have no audio' }, { status: 404 });
  if (!/^https?:\/\//i.test(ref)) return NextResponse.json({ error: 'Recording reference is not playable from this server.' }, { status: 404 });
  if (isPrivateHost(ref)) return NextResponse.json({ error: 'Recording reference points to a private network address and was blocked.' }, { status: 400 });

  try {
    const upstream = await fetch(ref, {
      headers: range ? { Range: range } : {},
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
    if (!upstream.ok && upstream.status !== 206) {
      return NextResponse.json({ error: `The provider could not supply this recording (HTTP ${upstream.status}).` }, { status: 502 });
    }
    const headers = new Headers({
      'Content-Type': upstream.headers.get('content-type') ?? rec.recording_mime ?? 'audio/mpeg',
      'Cache-Control': 'private, no-store',
      'Accept-Ranges': upstream.headers.get('accept-ranges') ?? 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    });
    for (const h of ['content-length', 'content-range']) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    return new NextResponse(upstream.body, { status: upstream.status, headers });
  } catch {
    return NextResponse.json({ error: 'Could not reach the recording provider. Try again shortly.' }, { status: 502 });
  }
}

/** SSRF guard: never proxy to loopback / link-local / private ranges. */
function isPrivateHost(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return true; }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
  return false;
}
