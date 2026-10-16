import { NextResponse, type NextRequest } from 'next/server';
import { withSystem } from '@/lib/db';
import { safeEqual } from '@/lib/crypto';
import { requeueStale } from '@/lib/pipeline/jobs';
import { enqueueDueSyncs } from '@/lib/integrations/sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * External scheduler hook: POST /api/cron/tick with "Authorization: Bearer <CRON_SECRET>".
 * Queues due integration syncs and recovers stale jobs. The background worker does the actual work.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization') ?? '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!secret || !given || !safeEqual(given, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await withSystem(async (db) => {
    const syncsQueued = await enqueueDueSyncs(db);
    const staleRequeued = await requeueStale(db);
    return { syncsQueued, staleRequeued };
  });
  return NextResponse.json({ ok: true, ...result });
}
