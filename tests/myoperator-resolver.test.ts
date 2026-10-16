import { afterEach, describe, expect, it, vi } from 'vitest';
process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
import { encryptJson } from '@/lib/crypto';
import { getRecordingFetchInit } from '@/lib/pipeline/transcribe';

const db: any = { one: async () => ({ config: {}, secrets_enc: encryptJson({ apiToken: ' tok ' }) }) };
const S3 = 'https://developers-sounds-v2.s3.ap-south-1.amazonaws.com/c/x-v2.mp3';
afterEach(() => vi.unstubAllGlobals());

describe('MyOperator recording resolver', () => {
  it('gets a fresh link from /recordings/link using the filename', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (u: string) => { calls.push(u); return new Response(JSON.stringify({ status: 'success', url: S3 })); });
    const r = await getRecordingFetchInit({ db, orgId: 'o', connectionId: 'c', sourcePlatform: 'myoperator', ref: 'https://app.myoperator.com/rec/x.mp3' });
    expect(r.url).toBe(S3);
    expect(calls[0]).toBe('https://developers.myoperator.co/recordings/link?token=tok&file=x.mp3');
  });
  it('falls back to a search by unique_id when the ref has no filename', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (u: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.endsWith('/search')) return new Response(JSON.stringify({ data: { hits: [{ _source: { filename: 'real.mp3', additional_parameters: [{ ky: 'unique_id', vl: 'u1' }] } }] } }));
      return new Response(JSON.stringify(u.includes('file=real.mp3') ? { status: 'success', url: S3 } : { status: 'error' }));
    });
    const r = await getRecordingFetchInit({ db, orgId: 'o', connectionId: 'c', sourcePlatform: 'myoperator', ref: 'https://app.myoperator.com/calls/123', sourceRecordId: 'u1' });
    expect(r.url).toBe(S3);
    expect(calls).toEqual(['POST https://developers.myoperator.co/search', 'GET https://developers.myoperator.co/recordings/link?token=tok&file=real.mp3']);
  });
  it('fails clearly when no link is returned', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ status: 'error' })));
    await expect(getRecordingFetchInit({ db, orgId: 'o', connectionId: 'c', sourcePlatform: 'myoperator', ref: 'myoperator-file:gone.mp3' })).rejects.toThrow(/did not return a recording link/);
  });
});
