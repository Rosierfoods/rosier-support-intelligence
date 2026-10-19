import { describe, it, expect } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { classifyResolution, ticketPriority } from '@/lib/orders/tickets';
import { pickOrderForContact } from '@/lib/orders/enrich';
import { findCustomerByPhone, findOrderByName, orderNameCandidates, shopifyConfigFrom, type ShopifyOrder } from '@/lib/providers/shopify';
import { mapMyOperatorCall } from '@/lib/providers/myoperator';
import { totalsByAgent, type DailyRow } from '@/lib/repos/activity';
import { buildXlsx, searchParamsToSP } from '@/lib/xlsx';
import { normalisePhone } from '@/lib/crypto';

describe('classifyResolution', () => {
  it.each([
    ['Agent initiated a refund of ₹499 to the original payment method', 'refund'],
    ['Replacement jar dispatched', 'replacement'],
    ['Arranged a reverse pickup', 'return'],
    ['Order will be reshipped tomorrow', 'redelivery'],
    ['Shared the tracking link and expected delivery date', 'information'],
    ['Something else entirely', 'other'],
    ['', 'none'],
    ['None', 'none'],
    ['N/A', 'none'],
  ])('%s → %s', (text, want) => expect(classifyResolution(text)).toBe(want));
  it('uses escalated status when no action text', () => expect(classifyResolution('', 'escalated')).toBe('escalated'));
  it('escalation text', () => expect(classifyResolution('Escalated to supervisor', 'open')).toBe('escalated'));
  it('priority from severity / sentiment', () => {
    expect(ticketPriority('critical', null)).toBe('urgent');
    expect(ticketPriority('high', null)).toBe('high');
    expect(ticketPriority(null, 'negative')).toBe('medium');
    expect(ticketPriority(null, 'positive')).toBe('low');
  });
});

const order = (name: string, createdAt: string): ShopifyOrder => ({
  id: `gid://shopify/Order/${name}`, name, createdAt, financialStatus: 'PAID', fulfillmentStatus: 'FULFILLED', total: '499.00', currency: 'INR',
  items: [], customerName: 'Asha', customerPhone: '+919812345678', adminUrl: '',
});

describe('order matching', () => {
  it('picks the latest order placed before the contact (or within a day after)', () => {
    const orders = [order('#1001', '2026-09-01T10:00:00Z'), order('#1003', '2026-09-20T10:00:00Z'), order('#1002', '2026-09-10T10:00:00Z')];
    expect(pickOrderForContact(orders, new Date('2026-09-15T00:00:00Z'))?.name).toBe('#1002');
    expect(pickOrderForContact(orders, new Date('2026-09-19T12:00:00Z'))?.name).toBe('#1003');
    expect(pickOrderForContact(orders, new Date('2026-08-01T00:00:00Z'))).toBeNull();
  });
  it('order name candidates', () => {
    expect(orderNameCandidates('#1234')).toEqual(['#1234', '1234']);
    expect(orderNameCandidates(' RF-1234 ')).toEqual(['#RF-1234', 'RF-1234', '#1234']);
    expect(orderNameCandidates('')).toEqual([]);
  });
  it('normalises Indian numbers', () => {
    expect(normalisePhone('98123 45678')).toBe('919812345678');
    expect(normalisePhone('+91-98123-45678')).toBe('919812345678');
    expect(normalisePhone('123')).toBeNull();
  });
});

describe('Shopify client (mocked)', () => {
  const cfg = shopifyConfigFrom({ shopDomain: 'https://rosier-test.myshopify.com/admin' }, { clientId: 'cid', clientSecret: 'sec' });
  const gqlOrder = { id: 'gid://shopify/Order/55', name: '#1234', createdAt: '2026-09-10T10:00:00Z', displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED',
    totalPriceSet: { shopMoney: { amount: '649.00', currencyCode: 'INR' } }, lineItems: { nodes: [{ title: 'A2 Ghee 500ml', quantity: 1 }] },
    customer: { displayName: 'Asha Rao', phone: '+919812345678' }, shippingAddress: null };

  it('normalises the shop domain', () => expect(cfg.shop).toBe('rosier-test.myshopify.com'));
  it('rejects a non-myshopify domain', () => expect(() => shopifyConfigFrom({ shopDomain: 'rosierfoods.com' }, { accessToken: 'x' })).toThrow(/myshopify/));

  it('gets a client-credentials token, then finds an order by name', async () => {
    const calls: { url: string; body: string }[] = [];
    const fake = (async (url: string, init: any) => {
      calls.push({ url, body: String(init.body) });
      if (url.endsWith('/admin/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 86399 }), { status: 200 });
      return new Response(JSON.stringify({ data: { orders: { nodes: [gqlOrder] } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const o = await findOrderByName(cfg, '1234', fake);
    expect(o?.name).toBe('#1234');
    expect(o?.total).toBe('649.00');
    expect(o?.customerName).toBe('Asha Rao');
    expect(calls[0].body).toContain('grant_type=client_credentials');
    expect(calls[1].url).toContain('/admin/api/2026-07/graphql.json');
  });

  it('falls back to guest orders by shipping phone', async () => {
    const guest = { ...gqlOrder, customer: null, shippingAddress: { name: 'Guest Buyer', phone: '098123 45678' } };
    const fake = (async (url: string, init: any) => {
      if (url.endsWith('/access_token')) return new Response(JSON.stringify({ access_token: 'tok2' }), { status: 200 });
      const q = JSON.parse(String(init.body)).query as string;
      if (q.includes('customers(')) return new Response(JSON.stringify({ data: { customers: { nodes: [] } } }), { status: 200 });
      return new Response(JSON.stringify({ data: { orders: { nodes: [guest] } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = await findCustomerByPhone({ ...cfg, accessToken: 'static' }, '919812345678', fake);
    expect(c?.name).toBe('Guest Buyer');
    expect(c?.orders[0].name).toBe('#1234');
  });
});

describe('MyOperator agent number', () => {
  it('uses the agent-side leg number when the leg has no agent object', () => {
    const n = mapMyOperatorCall({
      allcaller_id: 'abc', caller_number: '+919900011122', start_time: 1760000000, end_time: 1760000120, duration: '00:02:00', type: '2', status: 1,
      log_details: [{ contact: '+919900011122' }, { contact: '+918888877777', duration: '00:01:50' }],
    });
    expect(n?.direction).toBe('outbound');
    expect(n?.agent?.phone).toBe('+918888877777');
    expect(n?.call?.fromNumber).toBe('+918888877777');
  });
});

describe('agent activity totals', () => {
  const row = (day: string, agent: string | null, calls_in: number, calls_out: number): DailyRow => ({
    day, agent_id: agent, agent_name: agent, calls_in, calls_out, answered: calls_in + calls_out, missed: 0, talk_seconds: 60, chats: 1, chat_replies: 3, emails: 0, email_replies: 0, total: calls_in + calls_out + 1,
  });
  it('sums per agent and counts active days', () => {
    const t = totalsByAgent([row('2026-10-01', 'a', 2, 1), row('2026-10-02', 'a', 1, 0), row('2026-10-01', null, 9, 0)]);
    const a = t.find((x) => x.agent_id === 'a')!;
    expect(a.days).toBe(2);
    expect(a.calls_in).toBe(3);
    expect(a.chat_replies).toBe(6);
    expect(t[0].agent_id).toBeNull(); // sorted by total desc
  });
});

describe('xlsx', () => {
  it('builds a valid zip with sheets and guards formulas', () => {
    const buf = buildXlsx([{ name: 'Tickets', rows: [['Order ID', 'Amount'], ['#1234', 499], ['=HYPERLINK("x")', null]] }, { name: 'Info', rows: [['a']] }]);
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    // read the first sheet entry back
    const names: string[] = [];
    let off = 0; let sheet = '';
    while (buf.readUInt32LE(off) === 0x04034b50) {
      const comp = buf.readUInt32LE(off + 18); const nlen = buf.readUInt16LE(off + 26); const xlen = buf.readUInt16LE(off + 28);
      const name = buf.subarray(off + 30, off + 30 + nlen).toString(); names.push(name);
      const data = buf.subarray(off + 30 + nlen + xlen, off + 30 + nlen + xlen + comp);
      if (name === 'xl/worksheets/sheet1.xml') sheet = inflateRawSync(data).toString();
      off += 30 + nlen + xlen + comp;
    }
    expect(names).toContain('xl/worksheets/sheet2.xml');
    expect(sheet).toContain('#1234');
    expect(sheet).toContain('<v>499</v>');
    expect(sheet).not.toContain('>=HYPERLINK');
  });
  it('search params keep repeated keys', () => {
    expect(searchParamsToSP(new URLSearchParams('a=1&a=2&b=3'))).toEqual({ a: ['1', '2'], b: '3' });
  });
});
