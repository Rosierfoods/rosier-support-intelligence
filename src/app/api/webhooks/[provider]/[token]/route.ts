import { NextResponse, type NextRequest } from 'next/server';
import { rateLimit } from '@/lib/auth/rate-limit';
import { handleIncomingWebhook, MAX_WEBHOOK_BYTES } from '@/lib/integrations/webhooks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Inbound provider webhooks: /api/webhooks/{provider}/{token}
 * GET  → verification handshakes (e.g. Meta hub.challenge).
 * POST → verify signature / shared key, store event (deduplicated), queue processing, return 200 quickly.
 */
async function handle(req: NextRequest, params: { provider: string; token: string }) {
  const rl = rateLimit(`webhook:${params.token}`, 600, 60_000);
  if (!rl.ok) {
    return new NextResponse('Too many requests', { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } });
  }
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_WEBHOOK_BYTES) return new NextResponse('Payload too large', { status: 413 });
  const rawBody = req.method === 'GET' ? '' : await req.text();
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_WEBHOOK_BYTES) return new NextResponse('Payload too large', { status: 413 });

  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const query: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => { query[k] = v; });

  try {
    const r = await handleIncomingWebhook({ provider: params.provider, token: params.token, method: req.method, headers, rawBody, query });
    return new NextResponse(r.body, { status: r.status, headers: { 'Content-Type': r.contentType ?? 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  } catch {
    // Never leak internals; a 500 makes the provider retry later.
    return new NextResponse('Temporary error', { status: 500 });
  }
}

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ provider: string; token: string }> }
) {
  const params = await props.params;
  return handle(req, params);
}
export async function POST(
  req: NextRequest,
  props: { params: Promise<{ provider: string; token: string }> }
) {
  const params = await props.params;
  return handle(req, params);
}
