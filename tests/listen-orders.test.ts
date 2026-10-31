import { describe, it, expect } from 'vitest';
import { asciiDigits, extractOrderCandidates, orderMentioned, spokenDigitsToNumbers } from '@/lib/orders/extract';
import { scoreForFounder, MUST_LISTEN, SHOULD_LISTEN, type ListenFeatures } from '@/lib/repos/listen';
import { agentHintFrom, mapMyOperatorCall } from '@/lib/providers/myoperator';
import { mapChatwootConversation } from '@/lib/providers/limechat';

describe('order numbers from conversations', () => {
  it.each([
    ['Customer: mera order number 5 4 1 0 5 hai, ghee leak ho gaya', ['54105']],
    ['Customer: order number paanch chaar ek shunya paanch', ['54105']],
    ['Customer: order number five four one zero five', ['54105']],
    ['ग्राहक: मेरा ऑर्डर नंबर ५४१०५ है', ['54105']],
    ['Customer: my order id is #RF54105, call 9812345678', ['RF54105']],
    ['Customer: I paid 1500 rupees for the order 1500 rupees', []],
    ['Customer: I want to return it, no problem, call me at 9812345678', []],
    ['Agent: aapka order kab kiya tha? Customer: do din pehle', []],
  ])('%s', (text, want) => expect(extractOrderCandidates(text)).toEqual(want));

  it('accepts an AI order number only if it was really said', () => {
    expect(orderMentioned('54105', 'order number paanch chaar ek shunya paanch')).toBe(true);
    expect(orderMentioned('#54105', 'मेरा ऑर्डर ५४१०५')).toBe(true);
    expect(orderMentioned('54105', 'order 5 4 1 0 5')).toBe(true);
    expect(orderMentioned('99999', 'order 5 4 1 0 5')).toBe(false);
    expect(orderMentioned('', 'anything')).toBe(false);
  });
  it('digit helpers', () => {
    expect(asciiDigits('५४१')).toBe('541');
    expect(spokenDigitsToNumbers('do din pehle')).toBe('do din pehle'); // ordinary words stay words
  });
});

const base: ListenFeatures = {
  critical: 0, high: 0, critical_titles: [], quality: 85, wrong_info: 0, policy_violations: 0, frustration: 0, sentiment: 'neutral',
  resolution_status: 'resolved', product_severity: 'low', issue: null, action: null, repeat_contacts: 0, duration_seconds: 120, channel: 'call',
};

describe('founder listen score', () => {
  it('a normal good call is not listed', () => expect(scoreForFounder(base).level).toBe('none'));
  it('a critical alert is a must listen', () => {
    const r = scoreForFounder({ ...base, critical: 1, critical_titles: ['Rude behaviour'], sentiment: 'negative' });
    expect(r.level).toBe('must');
    expect(r.score).toBeGreaterThanOrEqual(MUST_LISTEN);
    expect(r.reasons[0]).toContain('Rude behaviour');
  });
  it('wrong information + weak handling is a should listen', () => {
    const r = scoreForFounder({ ...base, wrong_info: 1, quality: 60 });
    expect(r.score).toBeGreaterThanOrEqual(SHOULD_LISTEN);
    expect(r.level).toBe('should');
  });
  it('repeat contacts and refunds add up', () => {
    const r = scoreForFounder({ ...base, repeat_contacts: 3, action: 'refund', sentiment: 'negative', frustration: 3, resolution_status: 'escalated' });
    expect(r.level).toBe('must');
    expect(r.reasons).toContain('Customer contacted us 4 times in a week');
  });
});

describe('agent detection', () => {
  it('reads top-level agent fields when legs have no agent object', () => {
    const n = mapMyOperatorCall({ allcaller_id: 'x', caller_number: '+919900011122', start_time: 1760000000, duration: '00:01:00', type: '1', status: 1,
      agent_name: 'Priya', agent_number: '+918888877777', log_details: [] });
    expect(n?.agent?.name).toBe('Priya');
    expect(n?.agent?.phone).toBe('+918888877777');
  });
  it('builds a hint of agent-side names/numbers, never the customer number', () => {
    const hint = agentHintFrom({ department_name: 'Support' }, [{ received_by: [{ name: 'Rahul', contact: '+917777766666' }] }, { contact: '+919900011122' }], '+919900011122');
    expect(hint).toContain('Rahul');
    expect(hint).toContain('+917777766666');
    expect(hint).not.toContain('9900011122');
  });
  it('LimeChat chat without assignee takes the agent who replied after the bot', () => {
    const now = Math.floor(Date.now() / 1000);
    const r = mapChatwootConversation({ id: 9, meta: { channel: 'Channel::Whatsapp', sender: {} } }, [
      { id: 1, content: 'Hi', message_type: 0, created_at: now - 300, sender: { type: 'contact' } },
      { id: 2, content: 'I am the bot', message_type: 1, created_at: now - 290, sender: { type: 'agent_bot', name: 'Bot' } },
      { id: 3, content: 'Neha here, sorry!', message_type: 1, created_at: now - 100, sender: { type: 'user', id: 44, name: 'Neha', email: 'neha@rosierfoods.com' } },
    ])!;
    expect(r.agent?.name).toBe('Neha');
    expect(r.agent?.email).toBe('neha@rosierfoods.com');
  });
});

import { enrichInteraction } from '@/lib/orders/enrich';

describe('order fallback', () => {
  it('shows an order number said in the conversation even when Shopify cannot confirm it', async () => {
    const calls: unknown[][] = [];
    const db = { exec: async (_sql: string, params: unknown[]) => { calls.push(params); return 1; }, one: async () => null, query: async () => [] } as any;
    await enrichInteraction(db, null, { id: 'i1', org_id: 'o', channel: 'call', occurred_at: new Date(), order_ref: null, order_source: null,
      customer_id: null, customer_phone: null, customer_name: null, ticket_id: null, order_candidates: ['54105'] });
    expect(calls[0].slice(0, 4)).toEqual(['i1', '54105', 'ai', false]);
  });
});
