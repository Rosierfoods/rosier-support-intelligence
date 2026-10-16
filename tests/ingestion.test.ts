import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseWhatsAppPayload } from '@/lib/providers/whatsapp-cloud';
import { mapChatwootConversation, parseLimeChatWebhook } from '@/lib/providers/limechat';
import { decodeMyOperatorBody, extractLogDocs, mapCallStatus, mapMyOperatorCall } from '@/lib/providers/myoperator';
import { mapGmailThread, parseAddresses, stripQuoted } from '@/lib/providers/gmail';
import { mapGraphMessages } from '@/lib/providers/m365';
import { toDate, toSeconds } from '@/lib/providers/http';
import { generateRef, REF_RE } from '@/lib/ingestion/ref';
import { conversationMetrics, emailHash, phoneHash, reviveRecord } from '@/lib/ingestion/ingest';
import { PROVIDERS, getProvider } from '@/lib/providers/registry';

const json = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

describe('interaction reference', () => {
  it('has the RSI-XXXXXX base36 format', () => {
    for (let i = 0; i < 200; i++) expect(generateRef()).toMatch(REF_RE);
  });
  it('is random enough that 5,000 refs do not collide', () => {
    const s = new Set(Array.from({ length: 5000 }, generateRef));
    expect(s.size).toBe(5000);
  });
});

describe('WhatsApp Cloud mapping', () => {
  it('maps a text message to a whatsapp interaction keyed by number + customer + IST day', () => {
    const ev = parseWhatsAppPayload(json('whatsapp-text.json'));
    expect(ev).toHaveLength(1);
    const r = ev[0].records[0];
    expect(r.sourcePlatform).toBe('whatsapp_cloud');
    expect(r.channel).toBe('whatsapp');
    expect(r.sourceRecordId).toBe('106540352242922:919876543210:2025-06-09');
    expect(r.customer).toMatchObject({ name: 'Sheena Nelson', phone: '919876543210' });
    expect(r.messages![0]).toMatchObject({ senderType: 'customer', body: 'My ghee jar arrived leaking. Order #RF10234' });
    expect(r.messages![0].sentAt.toISOString()).toBe('2025-06-08T20:59:43.000Z');
  });
  it('keeps media as attachment metadata with the caption as body', () => {
    const r = parseWhatsAppPayload(json('whatsapp-image.json'))[0].records[0];
    expect(r.messages![0].body).toBe('Photo of the jar');
    expect(r.messages![0].attachments![0]).toMatchObject({ mimeType: 'image/jpeg', sourceRef: 'whatsapp-media:1003383421387256' });
  });
  it('ignores status-only payloads (no message text)', () => {
    expect(parseWhatsAppPayload(json('whatsapp-status.json'))).toHaveLength(0);
  });
});

describe('LimeChat (Chatwoot-compatible) mapping', () => {
  it('maps a conversation + messages into an ordered thread, skipping private notes', () => {
    const r = mapChatwootConversation(json('limechat-conversation.json'), json('limechat-messages.json').payload)!;
    expect(r.sourceRecordId).toBe('4521');
    expect(r.channel).toBe('whatsapp');
    expect(r.resolutionStatus).toBe('resolved');
    expect(r.agent).toMatchObject({ externalId: '77', name: 'Rahul', email: 'rahul@rosierfoods.com' });
    expect(r.customer).toMatchObject({ name: 'Priya Sharma', phone: '+919812345678', email: 'priya@example.com', externalId: '991' });
    expect(r.messages!.map((m) => [m.externalId, m.senderType])).toEqual([
      ['1001', 'customer'], ['1002', 'bot'], ['1003', 'system'], ['1004', 'agent'], ['1006', 'customer'],
    ]);
    expect(r.messages![4].attachments![0]).toMatchObject({ fileName: 'photo.jpg', mimeType: 'image/jpg', sizeBytes: 20480 });
    expect(r.direction).toBe('inbound');
  });
  it('maps a message_created webhook to a single-message update of the same conversation', () => {
    const [r] = parseLimeChatWebhook(json('limechat-webhook-message.json'));
    expect(r.sourceRecordId).toBe('4521');
    expect(r.messages).toHaveLength(1);
    expect(r.messages![0]).toMatchObject({ externalId: '1007', senderType: 'customer', body: 'Is there any update?' });
    expect(r.resolutionStatus).toBe('open');
    expect(r.customer?.phone).toBe('+919812345678');
  });
  it('ignores typing events', () => {
    expect(parseLimeChatWebhook({ event: 'conversation_typing_on', conversation: { id: 1 } })).toHaveLength(0);
  });
});

describe('MyOperator mapping', () => {
  it('maps the legacy short-key call log', () => {
    const r = mapMyOperatorCall(json('myoperator-legacy.json'))!;
    expect(r.sourceRecordId).toBe('s5.347638.78643857');
    expect(r.channel).toBe('call');
    expect(r.direction).toBe('inbound');
    expect(r.call).toMatchObject({ status: 'answered', durationSeconds: 192, fromNumber: '+919876543210', toNumber: '9999999999' });
    expect(r.call!.recordingRef).toMatch(/^https:\/\/recordings/);
    expect(r.agent).toMatchObject({ externalId: 'u-889', name: 'Anjali K', email: 'anjali@rosierfoods.com' });
    expect(r.occurredAt.toISOString()).toBe('2019-12-31T13:11:13.000Z');
  });
  it('maps call.completed (missed, no recording)', () => {
    const r = mapMyOperatorCall(json('myoperator-completed.json'))!;
    expect(r.sourceRecordId).toBe('c_7781');
    expect(r.call).toMatchObject({ status: 'missed', durationSeconds: 0, recordingRef: null });
    expect(r.customer?.phone).toBe('+919812300000');
    expect(r.agent).toBeUndefined();
  });
  it('maps Webhook v2 call.end with a recording file name only', () => {
    const r = mapMyOperatorCall(json('myoperator-v2.json'))!;
    expect(r.sourceRecordId).toBe('sess_9001');
    expect(r.call).toMatchObject({ status: 'answered', durationSeconds: 245, ringSeconds: 7, recordingRef: 'myoperator-file:rec_9001.wav' });
    expect(r.agent).toMatchObject({ externalId: 'ag-1', name: 'Vikas' });
  });
  it('ignores in-progress v2 events', () => {
    expect(mapMyOperatorCall({ event: 'call.initiated', session_id: 'x', data: {} })).toBeNull();
  });
  it('decodes form-encoded myoperator=<json> bodies', () => {
    const raw = 'myoperator=' + encodeURIComponent(JSON.stringify(json('myoperator-legacy.json')));
    const d = decodeMyOperatorBody(raw, 'application/x-www-form-urlencoded');
    expect(d._ai).toBe('5f1d2c3b4a');
    expect(decodeMyOperatorBody(JSON.stringify({ myoperator: JSON.stringify({ _ai: 'z' }) }), 'application/json')._ai).toBe('z');
  });
  it('extracts docs from search responses of several shapes', () => {
    expect(extractLogDocs({ status: 'success', data: { hits: [{ _source: { _ai: '1' } }] } })).toEqual([{ _ai: '1' }]);
    expect(extractLogDocs({ data: [{ _ai: '2' }] })).toEqual([{ _ai: '2' }]);
    expect(extractLogDocs({ status: 'success' })).toEqual([]);
  });
  it('normalises status vocabularies', () => {
    expect(mapCallStatus('Connected')).toBe('answered');
    expect(mapCallStatus(2)).toBe('missed');
    expect(mapCallStatus('abandoned')).toBe('missed');
    expect(mapCallStatus('3')).toBe('voicemail');
    expect(mapCallStatus('busy')).toBe('failed');
    expect(mapCallStatus(undefined, 30)).toBe('answered');
  });
});

describe('Email mapping', () => {
  it('maps a Gmail thread: customer vs agent, quoted text stripped, attachments as metadata', () => {
    const r = mapGmailThread(json('gmail-thread.json'), ['support@rosierfoods.com'])!;
    expect(r).toMatchObject({ sourcePlatform: 'gmail', sourceRecordId: '18c1a', channel: 'email', direction: 'inbound', subject: 'Refund not received for order RF1001' });
    expect(r.customer).toMatchObject({ name: 'Amit Gupta', email: 'amit@example.com' });
    expect(r.emails!.map((e) => e.senderType)).toEqual(['customer', 'agent']);
    expect(r.emails![0].bodyText).toContain('still no refund');
    expect(r.emails![0].attachments![0]).toMatchObject({ fileName: 'invoice.pdf', sizeBytes: 5120 });
    expect(r.emails![1].bodyText).toBe('Hi Amit, the refund was initiated today.');
  });
  it('groups Graph messages by conversationId and skips drafts', () => {
    const recs = mapGraphMessages(json('graph-messages.json').value, ['care@rosierfoods.com']);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ sourcePlatform: 'm365', sourceRecordId: 'CONV1', subject: 'Damaged mustard oil bottle' });
    expect(recs[0].emails!.map((e) => e.senderType)).toEqual(['customer', 'agent']);
    expect(recs[0].emails![1].bodyText).toBe('So sorry, Neha! A replacement is on its way.');
    expect(recs[0].customer?.email).toBe('neha@example.com');
  });
  it('address and quote helpers', () => {
    expect(parseAddresses('A <a@x.com>, "B, C" <b@y.in>')).toEqual(['a@x.com', 'b@y.in']);
    expect(stripQuoted('Thanks!\n> old\n> older')).toBe('Thanks!');
  });
});

describe('ingestion helpers', () => {
  it('computes first response and awaiting-agent time from the thread', () => {
    const t = (m: number) => new Date(Date.UTC(2025, 0, 1, 10, m));
    const m = conversationMetrics([
      { senderType: 'bot', sentAt: t(0), body: 'Welcome' },
      { senderType: 'customer', sentAt: t(1), body: 'Where is my order?' },
      { senderType: 'agent', sentAt: t(6), body: 'Checking' },
      { senderType: 'customer', sentAt: t(10), body: 'Any update?' },
      { senderType: 'customer', sentAt: t(12), body: 'Hello?' },
    ]);
    expect(m.firstResponseSeconds).toBe(300);
    expect(m.awaitingSince?.toISOString()).toBe(t(10).toISOString());
    expect(m.preview).toBe('Where is my order?');
    const answered = conversationMetrics([{ senderType: 'customer', sentAt: t(1), body: 'hi' }, { senderType: 'agent', sentAt: t(2), body: 'hello' }]);
    expect(answered.awaitingSince).toBeNull();
    expect(conversationMetrics([{ senderType: 'customer', sentAt: t(1), body: 'hi' }]).firstResponseSeconds).toBeNull();
  });
  it('hashes phone numbers after normalisation so formats match', () => {
    expect(phoneHash('+91 98765 43210')).toBe(phoneHash('9876543210'));
    expect(phoneHash('919876543210')).toBe(phoneHash('09876543210'.replace(/^0/, '')));
    expect(phoneHash('123')).toBeNull();
    expect(emailHash(' Priya@Example.com ')).toBe(emailHash('priya@example.com'));
    expect(emailHash('not-an-email')).toBeNull();
  });
  it('revives dates from stored webhook payload JSON', () => {
    const rec = parseWhatsAppPayload(json('whatsapp-text.json'))[0].records[0];
    const back = reviveRecord(JSON.parse(JSON.stringify(rec)));
    expect(back.occurredAt).toBeInstanceOf(Date);
    expect(back.messages![0].sentAt.getTime()).toBe(rec.messages![0].sentAt.getTime());
  });
  it('parses provider date / duration formats', () => {
    expect(toDate(1577797873)?.toISOString()).toBe('2019-12-31T13:11:13.000Z');
    expect(toDate('1749416383000')?.toISOString()).toBe('2025-06-08T20:59:43.000Z');
    expect(toDate('2020-08-01 08:35:56')?.toISOString()).toBe('2020-08-01T03:05:56.000Z'); // assumed IST
    expect(toDate('2025-08-21T11:02:44Z')?.toISOString()).toBe('2025-08-21T11:02:44.000Z');
    expect(toDate('garbage')).toBeNull();
    expect(toSeconds('00:03:12')).toBe(192);
    expect(toSeconds('3:05')).toBe(185);
    expect(toSeconds(42)).toBe(42);
    expect(toSeconds('n/a')).toBeNull();
  });
});

describe('registry', () => {
  it('lists every required provider with docs, scopes/setup info, and unique ids', () => {
    const ids = PROVIDERS.map((p) => p.id);
    for (const id of ['limechat', 'whatsapp_cloud', 'myoperator', 'gmail', 'm365', 'sarvam', 'anthropic']) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PROVIDERS) {
      expect(p.docsUrl).toMatch(/^https:\/\//);
      expect(p.setupSteps.length).toBeGreaterThan(0);
      if (p.supportsWebhook) expect(p.handleWebhook).toBeTypeOf('function');
      if (p.supportsPolling) expect(p.fetchSince).toBeTypeOf('function');
    }
    expect(getProvider('gmail')?.oauth).toBeTruthy();
    expect(getProvider('nope')).toBeNull();
  });
});

describe('MyOperator live Search Logs format', () => {
  it('maps data.hits[]._source documents (unique_id, unix times, hh:mm:ss duration, agent leg, recording)', async () => {
    const { extractLogDocs, mapMyOperatorCall } = await import('@/lib/providers/myoperator');
    const raw = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures/myoperator-search.json'), 'utf8'));
    const docs = extractLogDocs(raw);
    expect(docs).toHaveLength(2);
    const [missed, answered] = docs.map(mapMyOperatorCall);
    expect(missed?.sourceRecordId).toBe('cm1.1791810039.5186644');
    expect(missed?.call?.status).toBe('missed');
    expect(missed?.call?.durationSeconds).toBe(13);
    expect(answered?.call?.status).toBe('answered');
    expect(answered?.call?.durationSeconds).toBe(185);
    expect(answered?.agent?.externalId).toBe('agent-9');
    expect(answered?.call?.recordingRef).toBe('myoperator-file:rec_123.mp3');
  });
});
