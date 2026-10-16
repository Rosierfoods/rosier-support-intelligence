/**
 * Private object storage for retained recording / attachment copies.
 *   STORAGE_DRIVER=local     → files under STORAGE_LOCAL_DIR (default ./storage). Development only.
 *   STORAGE_DRIVER=supabase  → Supabase Storage private bucket via REST with the service-role key
 *                              (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET).
 *     Endpoints (Supabase Storage API, https://supabase.github.io/storage/):
 *       POST   /storage/v1/object/{bucket}/{key}         upload (x-upsert: true)
 *       GET    /storage/v1/object/{bucket}/{key}         authenticated download
 *       DELETE /storage/v1/object/{bucket}  {prefixes}   delete
 *       POST   /storage/v1/object/sign/{bucket}/{key}    {expiresIn} → {signedURL}
 * Objects are never public. Reads go through the app (permission-checked) or short-lived signed URLs.
 */
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

export interface StoredObject { body: Buffer; contentType: string | null; size: number }
export interface StorageDriver {
  readonly name: 'local' | 'supabase';
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  /** Web ReadableStream for route handlers (supports large files without buffering when possible). */
  stream(key: string): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string | null; size: number | null } | null>;
  delete(keys: string[]): Promise<number>;
  /** Short-lived URL (Supabase) or null (local — stream through the app instead). */
  signedUrl(key: string, expiresInSeconds?: number): Promise<string | null>;
}

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,400}$/;
export function assertKey(key: string) {
  if (!KEY_RE.test(key) || key.includes('..') || key.includes('//')) throw new Error('Invalid storage key');
}

export function recordingKey(orgId: string, interactionId: string, mime: string | null) {
  const ext = extFor(mime);
  return `recordings/${orgId}/${interactionId}${ext}`;
}

export function extFor(mime: string | null | undefined) {
  const m = (mime ?? '').toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return '.mp3';
  if (m.includes('wav')) return '.wav';
  if (m.includes('ogg') || m.includes('opus')) return '.ogg';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return '.m4a';
  if (m.includes('webm')) return '.webm';
  if (m.includes('flac')) return '.flac';
  if (m.includes('amr')) return '.amr';
  return '.bin';
}

// ───────────────────────── Local ─────────────────────────
class LocalDriver implements StorageDriver {
  readonly name = 'local' as const;
  constructor(private root: string) {}
  private file(key: string) {
    assertKey(key);
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Invalid storage key');
    return p;
  }
  async put(key: string, data: Buffer, contentType: string) {
    const p = this.file(key);
    await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
    await fs.writeFile(p, data, { mode: 0o600 });
    await fs.writeFile(p + '.meta.json', JSON.stringify({ contentType }), { mode: 0o600 });
  }
  private async meta(p: string) {
    try { return JSON.parse(await fs.readFile(p + '.meta.json', 'utf8')) as { contentType?: string }; } catch { return {}; }
  }
  async get(key: string) {
    const p = this.file(key);
    try {
      const body = await fs.readFile(p);
      return { body, contentType: (await this.meta(p)).contentType ?? null, size: body.length };
    } catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async stream(key: string) {
    const p = this.file(key);
    try {
      const st = await fs.stat(p);
      const node = createReadStream(p);
      return { stream: Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>, contentType: (await this.meta(p)).contentType ?? null, size: st.size };
    } catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async delete(keys: string[]) {
    let n = 0;
    for (const k of keys) {
      const p = this.file(k);
      try { await fs.unlink(p); n++; } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      try { await fs.unlink(p + '.meta.json'); } catch { /* ignore */ }
    }
    return n;
  }
  async signedUrl() { return null; }
}

// ───────────────────────── Supabase ─────────────────────────
class SupabaseDriver implements StorageDriver {
  readonly name = 'supabase' as const;
  constructor(private url: string, private key: string, private bucket: string) {}
  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.key}`, apikey: this.key, ...extra };
  }
  private obj(key: string) {
    assertKey(key);
    return `${this.url}/storage/v1/object/${encodeURIComponent(this.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
  async put(key: string, data: Buffer, contentType: string) {
    const res = await fetch(this.obj(key), { method: 'POST', headers: this.headers({ 'content-type': contentType, 'x-upsert': 'true', 'cache-control': 'no-store' }), body: new Uint8Array(data) });
    if (!res.ok) throw new Error(`Supabase Storage upload failed (${res.status})`);
  }
  async get(key: string) {
    const res = await fetch(this.obj(key), { headers: this.headers() });
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new Error(`Supabase Storage download failed (${res.status})`);
    const body = Buffer.from(await res.arrayBuffer());
    return { body, contentType: res.headers.get('content-type'), size: body.length };
  }
  async stream(key: string) {
    const res = await fetch(this.obj(key), { headers: this.headers() });
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok || !res.body) throw new Error(`Supabase Storage download failed (${res.status})`);
    const len = res.headers.get('content-length');
    return { stream: res.body, contentType: res.headers.get('content-type'), size: len ? Number(len) : null };
  }
  async delete(keys: string[]) {
    if (!keys.length) return 0;
    keys.forEach(assertKey);
    const res = await fetch(`${this.url}/storage/v1/object/${encodeURIComponent(this.bucket)}`, {
      method: 'DELETE', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ prefixes: keys }),
    });
    if (!res.ok) throw new Error(`Supabase Storage delete failed (${res.status})`);
    const j = await res.json().catch(() => []);
    return Array.isArray(j) ? j.length : keys.length;
  }
  async signedUrl(key: string, expiresInSeconds = 300) {
    const res = await fetch(`${this.url}/storage/v1/object/sign/${encodeURIComponent(this.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ expiresIn: Math.max(30, Math.min(3600, expiresInSeconds)) }),
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const rel: string | undefined = j?.signedURL ?? j?.signedUrl;
    if (!rel) return null;
    return rel.startsWith('http') ? rel : `${this.url}/storage/v1${rel.startsWith('/') ? '' : '/'}${rel}`;
  }
}

let cached: StorageDriver | null = null;
export function getStorage(): StorageDriver {
  if (cached) return cached;
  const driver = (process.env.STORAGE_DRIVER ?? 'local').toLowerCase();
  if (driver === 'supabase') {
    const url = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    if (!url || !key) throw new Error('STORAGE_DRIVER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    cached = new SupabaseDriver(url, key, process.env.SUPABASE_STORAGE_BUCKET || 'rsi-private');
  } else {
    cached = new LocalDriver(path.resolve(process.env.STORAGE_LOCAL_DIR || './storage'));
  }
  return cached;
}

/** For tests. */
export function resetStorageForTests() { cached = null; }
