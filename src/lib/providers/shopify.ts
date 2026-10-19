/**
 * Shopify — customer names and order lookup (read-only Admin GraphQL API).
 *
 *   POST https://{shop}.myshopify.com/admin/api/{version}/graphql.json   header X-Shopify-Access-Token
 *   Auth, either:
 *     - Admin API access token (shpat_…) from a legacy custom app created before 2026, or
 *     - Dev Dashboard app (Client ID + Client secret) → client credentials grant:
 *         POST https://{shop}.myshopify.com/admin/oauth/access_token
 *         form: grant_type=client_credentials, client_id, client_secret → { access_token, scope, expires_in: 86399 }
 *       (app and store must be in the same Shopify organization).
 *   Scopes needed: read_customers, read_orders.
 */
import type { ProviderContext, ProviderDefinition, TestResult } from './types';
import { ProviderError, parseRetryAfter } from '@/lib/ai/errors';
import { networkReason } from './anthropic';

export const DEFAULT_SHOPIFY_API_VERSION = '2026-07';

export interface ShopifyConfig { shop: string; apiVersion: string; accessToken?: string; clientId?: string; clientSecret?: string }

export function shopifyConfigFrom(config: Record<string, any>, secrets: Record<string, string>): ShopifyConfig {
  let shop = String(config.shopDomain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (shop && !shop.includes('.')) shop = `${shop}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    throw new ProviderError('shopify', 'Enter your store\'s myshopify.com domain, e.g. rosierfoods.myshopify.com (Shopify admin → Settings → Domains).', { retryable: false });
  }
  const apiVersion = /^\d{4}-\d{2}$/.test(String(config.apiVersion ?? '')) ? String(config.apiVersion) : DEFAULT_SHOPIFY_API_VERSION;
  const accessToken = (secrets.accessToken ?? '').trim() || undefined;
  const clientId = (secrets.clientId ?? '').trim() || undefined;
  const clientSecret = (secrets.clientSecret ?? '').trim() || undefined;
  if (!accessToken && !(clientId && clientSecret)) {
    throw new ProviderError('shopify', 'Add either an Admin API access token, or the Client ID and Client secret of your Dev Dashboard app.', { retryable: false });
  }
  return { shop, apiVersion, accessToken, clientId, clientSecret };
}

// Client-credentials tokens last 24 h; cache per shop+client in memory.
const tokenCache = new Map<string, { token: string; exp: number }>();

async function getToken(cfg: ShopifyConfig, fetchImpl: typeof fetch): Promise<string> {
  if (cfg.accessToken) return cfg.accessToken;
  const key = `${cfg.shop}:${cfg.clientId}`;
  const hit = tokenCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.token;
  let res: Response;
  try {
    res = await fetchImpl(`https://${cfg.shop}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId!, client_secret: cfg.clientSecret! }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new ProviderError('shopify', `Could not reach Shopify (${networkReason(e)}).`, { retryable: true });
  }
  const text = await res.text();
  if (!res.ok) {
    const hint = /shop_not_permitted/.test(text) ? ' The app and the store must be in the same Shopify organization (Dev Dashboard).'
      : /app_not_installed/.test(text) ? ' Install the app on the store first (Dev Dashboard → your app → Install).' : '';
    throw new ProviderError('shopify', `Shopify rejected the Client ID / secret (${res.status}).${hint}`, { status: res.status });
  }
  const j = JSON.parse(text);
  const exp = Date.now() + Math.max(60, Number(j.expires_in ?? 86399) - 300) * 1000;
  tokenCache.set(key, { token: String(j.access_token), exp });
  return String(j.access_token);
}

export async function shopifyGraphql<T = any>(cfg: ShopifyConfig, query: string, variables: Record<string, unknown> = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  const token = await getToken(cfg, fetchImpl);
  let res: Response;
  try {
    res = await fetchImpl(`https://${cfg.shop}/admin/api/${cfg.apiVersion}/graphql.json`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new ProviderError('shopify', `Could not reach Shopify (${networkReason(e)}).`, { retryable: true });
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    if (!cfg.accessToken) tokenCache.delete(`${cfg.shop}:${cfg.clientId}`);
    throw new ProviderError('shopify', `Shopify refused access (${res.status}). Check the token and that the app has read_customers and read_orders.`, { status: res.status });
  }
  if (res.status === 429) throw new ProviderError('shopify', 'Shopify rate limit reached.', { status: 429, retryable: true, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) ?? 10_000 });
  if (!res.ok) throw new ProviderError('shopify', `Shopify API error (${res.status}).`, { status: res.status, retryable: res.status >= 500 });
  const j = JSON.parse(text);
  if (j.errors?.length) {
    const msg = String(j.errors[0]?.message ?? 'GraphQL error');
    const throttled = /throttled/i.test(msg);
    throw new ProviderError('shopify', `Shopify: ${msg.slice(0, 200)}`, { retryable: throttled, retryAfterMs: throttled ? 5_000 : undefined });
  }
  return j.data as T;
}

// ───────────────────────── Lookups ─────────────────────────
export interface ShopifyOrder {
  id: string; name: string; createdAt: string; financialStatus: string | null; fulfillmentStatus: string | null;
  total: string | null; currency: string | null; items: { title: string; quantity: number }[];
  customerName: string | null; customerPhone: string | null; adminUrl: string;
}
export interface ShopifyCustomer { id: string; name: string | null; phone: string | null; email: string | null; orders: ShopifyOrder[] }

const ORDER_FIELDS = `id name createdAt displayFinancialStatus displayFulfillmentStatus
  totalPriceSet { shopMoney { amount currencyCode } }
  lineItems(first: 10) { nodes { title quantity } }
  customer { displayName phone }
  shippingAddress { name phone }`;

function mapOrder(cfg: ShopifyConfig, o: any): ShopifyOrder {
  const numericId = String(o.id ?? '').split('/').pop();
  return {
    id: String(o.id), name: String(o.name), createdAt: String(o.createdAt),
    financialStatus: o.displayFinancialStatus ?? null, fulfillmentStatus: o.displayFulfillmentStatus ?? null,
    total: o.totalPriceSet?.shopMoney?.amount ?? null, currency: o.totalPriceSet?.shopMoney?.currencyCode ?? null,
    items: (o.lineItems?.nodes ?? []).map((l: any) => ({ title: String(l.title), quantity: Number(l.quantity ?? 1) })),
    customerName: o.customer?.displayName ?? o.shippingAddress?.name ?? null,
    customerPhone: o.customer?.phone ?? o.shippingAddress?.phone ?? null,
    adminUrl: `https://${cfg.shop}/admin/orders/${numericId}`,
  };
}

/** Candidate spellings of an order reference ("#1234", "1234", "RF-1234" …). */
export function orderNameCandidates(ref: string): string[] {
  const r = ref.trim().replace(/\s+/g, '');
  if (!r) return [];
  const bare = r.replace(/^#/, '');
  const out = new Set<string>([`#${bare}`, bare]);
  const digits = bare.replace(/\D/g, '');
  if (digits.length >= 3 && digits !== bare) out.add(`#${digits}`);
  return Array.from(out).slice(0, 4);
}

export async function findOrderByName(cfg: ShopifyConfig, ref: string, fetchImpl: typeof fetch = fetch): Promise<ShopifyOrder | null> {
  for (const name of orderNameCandidates(ref)) {
    const d = await shopifyGraphql<any>(cfg, `query($q: String!) { orders(first: 1, query: $q) { nodes { ${ORDER_FIELDS} } } }`,
      { q: `name:${JSON.stringify(name)}` }, fetchImpl);
    const o = d?.orders?.nodes?.[0];
    if (o && String(o.name).replace(/^#/, '').toLowerCase() === name.replace(/^#/, '').toLowerCase()) return mapOrder(cfg, o);
  }
  return null;
}

/** Find the customer (and their latest orders) by phone. Tries customer phone, then orders with that number. */
export async function findCustomerByPhone(cfg: ShopifyConfig, phoneDigits: string, fetchImpl: typeof fetch = fetch): Promise<ShopifyCustomer | null> {
  const ten = phoneDigits.slice(-10);
  if (ten.length < 10) return null;
  const variants = [`+91${ten}`, ten];
  for (const v of variants) {
    const d = await shopifyGraphql<any>(cfg, `query($q: String!) { customers(first: 1, query: $q) { nodes {
        id displayName phone email
        orders(first: 5, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } } } } }`, { q: `phone:${JSON.stringify(v)}` }, fetchImpl);
    const c = d?.customers?.nodes?.[0];
    if (c) return { id: String(c.id), name: c.displayName ?? null, phone: c.phone ?? null, email: c.email ?? null, orders: (c.orders?.nodes ?? []).map((o: any) => mapOrder(cfg, o)) };
  }
  // Guest checkouts: the number often lives only on the order's shipping address.
  const d = await shopifyGraphql<any>(cfg, `query($q: String!) { orders(first: 5, sortKey: CREATED_AT, reverse: true, query: $q) { nodes { ${ORDER_FIELDS} } } }`, { q: ten }, fetchImpl);
  const orders = (d?.orders?.nodes ?? []).map((o: any) => mapOrder(cfg, o))
    .filter((o: ShopifyOrder) => (o.customerPhone ?? '').replace(/\D/g, '').endsWith(ten));
  if (!orders.length) return null;
  return { id: '', name: orders[0].customerName, phone: orders[0].customerPhone, email: null, orders };
}

// ───────────────────────── Provider card ─────────────────────────
async function testConnection(ctx: ProviderContext): Promise<TestResult> {
  try {
    const cfg = shopifyConfigFrom(ctx.config, ctx.secrets);
    const d = await shopifyGraphql<any>(cfg, `{ shop { name myshopifyDomain } orders(first: 1) { nodes { name } } }`);
    return { ok: true, message: `Connected to ${d?.shop?.name ?? cfg.shop}. Orders are readable${d?.orders?.nodes?.[0] ? ` (latest ${d.orders.nodes[0].name})` : ''}.` };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Could not connect to Shopify.' };
  }
}

export const shopifyProvider: ProviderDefinition = {
  id: 'shopify',
  name: 'Shopify',
  category: 'other',
  description: 'Matches each call / chat to a Shopify customer by phone number (shows the customer\'s name) and links the order: the order ID mentioned in the conversation is verified first; otherwise the customer\'s latest order is used.',
  docsUrl: 'https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant',
  authType: 'token',
  configFields: [
    { key: 'shopDomain', label: 'Store domain *', type: 'text', required: true, placeholder: 'rosierfoods.myshopify.com', help: 'Your myshopify.com domain (Shopify admin → Settings → Domains).' },
    { key: 'apiVersion', label: 'API version', type: 'text', placeholder: DEFAULT_SHOPIFY_API_VERSION, help: 'Leave blank for the default.' },
  ],
  secretFields: [
    { key: 'clientId', label: 'Client ID (Dev Dashboard app)', type: 'text', help: 'Shopify Dev Dashboard → your app → Settings.' },
    { key: 'clientSecret', label: 'Client secret (Dev Dashboard app)', type: 'password', help: 'Same page as the Client ID.' },
    { key: 'accessToken', label: 'Or: Admin API access token', type: 'password', placeholder: 'shpat_…', help: 'Only for an older custom app created in Shopify admin. Leave blank if you use Client ID + secret.' },
  ],
  scopes: [
    { key: 'read_customers', label: 'Read customers', description: 'Customer name, phone and email' },
    { key: 'read_orders', label: 'Read orders', description: 'Order number, status, items' },
  ],
  dataImported: ['Customer names for matching phone numbers', 'Order number, date, status, items and total for the linked order'],
  setupSteps: [
    'Go to dev.shopify.com (Dev Dashboard) signed in as the store owner → Create app → name it "Rosier CRM".',
    'Create a version with Admin API scopes read_customers and read_orders, release it, then Install the app on your store.',
    'Open the app → Settings, copy the Client ID and Client secret, paste them here with your store domain, Save, then Test connection.',
    'Calls and chats are matched automatically within a few minutes; older ones are checked in the background.',
  ],
  supportsWebhook: false,
  supportsPolling: false,
  limitations: [
    'Read-only — nothing is changed in Shopify.',
    'The app and the store must belong to the same Shopify organization for Client ID + secret to work.',
    'Matching uses the last 10 digits of the phone number.',
  ],
  testConnection,
};
