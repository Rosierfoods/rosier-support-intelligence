import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { verifyMetaSignature, whatsappCloudProvider } from '@/lib/providers/whatsapp-cloud';
import { verifyChatwootSignature, limechatProvider } from '@/lib/providers/limechat';
import { myoperatorProvider } from '@/lib/providers/myoperator';
import { checkSharedKey, errorMessage, networkMessage, scrubText, RetryableError, httpJson } from '@/lib/providers/http';
import { sanitizeHeaders } from '@/lib/integrations/webhooks';
import type { ProviderContext } from '@/lib/providers/types';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const sign = (secret: string, body: string) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
const ctx = (secrets: Record<string, string>, config: Record<string, any> = {}): ProviderContext =>
  ({ orgId: 'o', connectionId: 'c', config, secrets, appUrl: 'http://localhost:3000' });

beforeAll(() => {
  process.env.SECRETS_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
});

describe('WhatsApp Cloud API webhook signature (X-Hub-Signature-256)', () => {
  const secret = 'test-app-secret';
  const body = fx('whatsapp-text.json');

  it('accepts a valid signature', () => {
    expect(verifyMetaSignature(secret, body, sign(secret, body))).toBe(true);
  });
  it('rejects a wrong secret, a tampered body, a missing prefix and a missing header', () => {
    expect(verifyMetaSignature('other', body, sign(secret, body))).toBe(false);
    expect(verifyMetaSignature(secret, body + ' ', sign(secret, body))).toBe(false);
    expect(verifyMetaSignature(secret, body, sign(secret, body).slice(7))).toBe(false);
    expect(verifyMetaSignature(secret, body, undefined)).toBe(false);
    expect(verifyMetaSignature('', body, sign('', body))).toBe(false);
  });

  it('handleWebhook: signed POST yields one event per message; unsigned POST is not verified', async () => {
    const c = ctx({ appSecret: secret, verifyToken: 'vt' }, { phoneNumberId: '106540352242922' });
    const ok = await whatsappCloudProvider.handleWebhook!(c, { method: 'POST', rawBody: body, query: {}, headers: { 'X-Hub-Signature-256': sign(secret, body) } });
    expect(ok.verified).toBe(true);
    expect(ok.events).toHaveLength(1);
    expect(ok.events[0].key).toMatch(/^wamid:/);
    const bad = await whatsappCloudProvider.handleWebhook!(c, { method: 'POST', rawBody: body, query: {}, headers: { 'x-hub-signature-256': sign('nope', body) } });
    expect(bad.verified).toBe(false);
    expect(bad.events).toHaveLength(0);
  });

  it('handleWebhook: messages for another phone number id are skipped', async () => {
    const c = ctx({ appSecret: secret, verifyToken: 'vt' }, { phoneNumberId: '999' });
    const r = await whatsappCloudProvider.handleWebhook!(c, { method: 'POST', rawBody: body, query: {}, headers: { 'x-hub-signature-256': sign(secret, body) } });
    expect(r.verified).toBe(true);
    expect(r.events.every((e) => e.records.length === 0)).toBe(true);
  });

  it('GET verification handshake echoes hub.challenge only with the right verify token', async () => {
    const c = ctx({ appSecret: secret, verifyToken: 'my-verify-token' });
    const ok = await whatsappCloudProvider.handleWebhook!(c, { method: 'GET', rawBody: '', headers: {}, query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'my-verify-token', 'hub.challenge': '1158201444' } });
    expect(ok.verified).toBe(true);
    expect(ok.response).toEqual({ status: 200, body: '1158201444', contentType: 'text/plain' });
    const bad = await whatsappCloudProvider.handleWebhook!(c, { method: 'GET', rawBody: '', headers: {}, query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' } });
    expect(bad.verified).toBe(false);
    expect(bad.response?.status).toBe(403);
  });
});

describe('LimeChat / Chatwoot webhook verification', () => {
  const body = fx('limechat-webhook-message.json');
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'sha256=' + createHmac('sha256', 'whsec').update(`${ts}.${body}`).digest('hex');

  it('verifies X-Chatwoot-Signature over "{timestamp}.{body}" with a 5-minute window', () => {
    expect(verifyChatwootSignature('whsec', body, sig, ts)).toBe(true);
    expect(verifyChatwootSignature('other', body, sig, ts)).toBe(false);
    expect(verifyChatwootSignature('whsec', body, sig, String(Number(ts) - 600))).toBe(false);
    expect(verifyChatwootSignature('whsec', body, sig, undefined)).toBe(false);
  });

  it('falls back to the shared key when no signing secret is configured; rejects when nothing matches', async () => {
    const c = ctx({ webhookKey: 'shared-123' });
    const ok = await limechatProvider.handleWebhook!(c, { method: 'POST', rawBody: body, headers: {}, query: { key: 'shared-123' } });
    expect(ok.verified).toBe(true);
    expect(ok.events[0].records[0].sourceRecordId).toBe('4521');
    const bad = await limechatProvider.handleWebhook!(c, { method: 'POST', rawBody: body, headers: {}, query: { key: 'nope' } });
    expect(bad.verified).toBe(false);
    const none = await limechatProvider.handleWebhook!(ctx({}), { method: 'POST', rawBody: body, headers: {}, query: {} });
    expect(none.verified).toBe(false);
  });

  it('signed delivery uses X-Chatwoot-Delivery as the dedupe key', async () => {
    const c = ctx({ webhookSecret: 'whsec' });
    const r = await limechatProvider.handleWebhook!(c, { method: 'POST', rawBody: body, query: {},
      headers: { 'X-Chatwoot-Signature': sig, 'X-Chatwoot-Timestamp': ts, 'X-Chatwoot-Delivery': 'd-1' } });
    expect(r.verified).toBe(true);
    expect(r.events[0].key).toBe('delivery:d-1');
  });
});

describe('MyOperator webhook authentication', () => {
  const body = fx('myoperator-completed.json');
  it('accepts the configured custom header, ?key= and Basic-auth password; rejects otherwise', async () => {
    const c = ctx({ webhookKey: 'k-abc' }, { webhookHeader: 'X-Webhook-Token' });
    const h = await myoperatorProvider.handleWebhook!(c, { method: 'POST', rawBody: body, query: {}, headers: { 'x-webhook-token': 'k-abc', 'content-type': 'application/json' } });
    expect(h.verified).toBe(true);
    expect(h.events[0].key).toBe('event:evt_01J8ZK');
    const q = await myoperatorProvider.handleWebhook!(c, { method: 'POST', rawBody: body, query: { key: 'k-abc' }, headers: {} });
    expect(q.verified).toBe(true);
    const basic = 'Basic ' + Buffer.from('myoperator:k-abc').toString('base64');
    const b = await myoperatorProvider.handleWebhook!(c, { method: 'POST', rawBody: body, query: {}, headers: { authorization: basic } });
    expect(b.verified).toBe(true);
    const bad = await myoperatorProvider.handleWebhook!(c, { method: 'POST', rawBody: body, query: {}, headers: { 'x-webhook-token': 'wrong' } });
    expect(bad.verified).toBe(false);
  });
  it('verifies optional HMAC X-Webhook-Signature', async () => {
    const c = ctx({ webhookSigningSecret: 'hs' });
    const good = await myoperatorProvider.handleWebhook!(c, { method: 'POST', rawBody: body, query: {}, headers: { 'x-webhook-signature': createHmac('sha256', 'hs').update(body).digest('hex') } });
    expect(good.verified).toBe(true);
    const bad = await myoperatorProvider.handleWebhook!(c, { method: 'POST', rawBody: body, query: {}, headers: { 'x-webhook-signature': 'deadbeef' } });
    expect(bad.verified).toBe(false);
  });
});

describe('helpers', () => {
  it('checkSharedKey compares in constant time and needs a configured key', () => {
    expect(checkSharedKey({ headers: { 'X-RSI-Webhook-Key': 'abc' }, query: {} }, 'abc')).toBe(true);
    expect(checkSharedKey({ headers: {}, query: { key: 'abc' } }, 'abc')).toBe(true);
    expect(checkSharedKey({ headers: {}, query: { key: 'abc' } }, '')).toBe(false);
    expect(checkSharedKey({ headers: {}, query: { key: '' } }, 'abc')).toBe(false);
  });
  it('sanitizeHeaders redacts credentials and signatures', () => {
    const out = sanitizeHeaders({ Authorization: 'Bearer x', 'X-Hub-Signature-256': 'sha256=1', 'X-Custom-Token': 's3cret', 'Content-Type': 'application/json', Cookie: 'a=b' }, 'x-custom-token');
    expect(out.authorization).toBe('[redacted]');
    expect(out['x-hub-signature-256']).toBe('[redacted]');
    expect(out['x-custom-token']).toBe('[redacted]');
    expect(out.cookie).toBe('[redacted]');
    expect(out['content-type']).toBe('application/json');
  });
  it('error messages never contain tokens', () => {
    expect(scrubText('failed token=abc123&x=1 Bearer eyJhbGciOi.xyz')).not.toMatch(/abc123|eyJhbGciOi/);
    expect(networkMessage('https://developers.myoperator.co/search?token=SECRET', Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })))
      .toBe('Could not reach developers.myoperator.co: ENOTFOUND');
    expect(errorMessage(new Error('api_access_token: zzz-secret'))).not.toMatch(/zzz-secret/);
  });
  it('unreachable hosts become a clean RetryableError', async () => {
    await expect(httpJson('https://nonexistent.invalid/x?token=SECRET', { timeoutMs: 5000 })).rejects.toBeInstanceOf(RetryableError);
    try { await httpJson('https://nonexistent.invalid/x?token=SECRET', { timeoutMs: 5000 }); } catch (e) {
      expect(String((e as Error).message)).toMatch(/^Could not reach nonexistent\.invalid/);
      expect(String((e as Error).message)).not.toMatch(/SECRET/);
    }
  });
});
