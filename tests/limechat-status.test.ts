import { describe, it, expect, vi, afterEach } from 'vitest';
import { limechatProvider } from '@/lib/providers/limechat';

const ctx = { orgId: 'o', connectionId: 'c', config: { accountId: '28705' }, secrets: { apiAccessToken: 't' }, appUrl: 'http://x' };
const now = Math.floor(Date.now() / 1000);
const conv = (id: number, status: string) => ({ id, status, created_at: now - 100, last_activity_at: now - 50, meta: { sender: { name: 'Asha', phone_number: '+919812345678' }, channel: 'Channel::Whatsapp' } });

afterEach(() => vi.unstubAllGlobals());

function stub() {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    urls.push(u);
    const url = new URL(u);
    if (url.pathname.endsWith('/messages')) return new Response(JSON.stringify({ payload: [{ id: 1, content: 'hi', message_type: 0, created_at: now - 100, sender: { type: 'contact' } }] }), { status: 200 });
    const st = url.searchParams.get('status');
    if (st === 'all' || st === 'snoozed') return new Response(JSON.stringify({ error: 'Invalid status parameter' }), { status: 422 });
    const page = Number(url.searchParams.get('page'));
    const payload = page === 1 ? [conv(st === 'open' ? 1 : st === 'pending' ? 2 : 3, st!)] : [];
    return new Response(JSON.stringify({ data: { meta: { all_count: 3 }, payload } }), { status: 200 });
  }));
  return urls;
}

describe('LimeChat without status=all', () => {
  it('test connection succeeds and never sends status=all', async () => {
    const urls = stub();
    const r = await limechatProvider.testConnection!(ctx as any);
    expect(r.ok).toBe(true);
    expect(urls.some((u) => u.includes('status=all'))).toBe(false);
  });
  it('sync walks every status (skipping unsupported ones) and imports all conversations', async () => {
    const urls = stub();
    let cp: Record<string, any> = {};
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await limechatProvider.fetchSince!(ctx as any, cp, { from: new Date((now - 86400) * 1000) });
      ids.push(...r.records.map((x) => x.sourceRecordId));
      cp = r.checkpoint;
      if (!r.hasMore) break;
    }
    expect(ids.sort()).toEqual(['1', '2', '3']);
    expect(urls.some((u) => u.includes('status=all'))).toBe(false);
    expect(cp.since).toBeGreaterThan(0);
  });
});
