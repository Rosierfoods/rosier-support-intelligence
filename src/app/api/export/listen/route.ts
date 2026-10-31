import { NextResponse, type NextRequest } from 'next/server';
import { assertPermission, auditAction } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { getListenList, parseListenFilters } from '@/lib/repos/listen';
import { buildXlsx, istDateStamp, searchParamsToSP, xlsxResponseHeaders, type XCell } from '@/lib/xlsx';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  let s;
  try {
    s = await assertPermission('reports.export');
    if (!s.permissions.has('reports.view')) throw new Error('forbidden');
  } catch {
    return NextResponse.json({ error: 'You do not have permission to export this list.' }, { status: 403 });
  }
  const f = parseListenFilters(searchParamsToSP(req.nextUrl.searchParams));
  const session = s;
  const { rows } = await withOrg(session.org.id, async (db) => {
    const out = await getListenList(db, session, f, 2000);
    await auditAction(db, session, 'export.listen_list', null, null, { row_count: out.rows.length });
    return out;
  });
  const data: XCell[][] = [['Priority', 'Score', 'Order ID', 'Date / time (IST)', 'Channel', 'Incoming / outgoing', 'Customer', 'Customer phone', 'Agent',
    'Call duration (min)', 'Issue', 'Why listen', 'AI summary', 'Quality score', 'Listened', 'Listened by', 'Note']];
  for (const r of rows) {
    data.push([r.level === 'must' ? 'Must listen' : 'Should listen', r.score, r.order_ref ?? 'No order ID', new Date(r.occurred_at), r.channel,
      r.channel === 'call' ? (r.direction === 'outbound' ? 'Outgoing' : 'Incoming') : r.direction === 'outbound' ? 'Sent' : 'Received',
      r.customer_name, r.customer_phone, r.agent_name ?? 'Unassigned', r.duration_seconds ? Math.round(r.duration_seconds / 6) / 10 : null,
      r.issue, r.reasons.join('; '), r.summary, r.quality === null ? null : Math.round(r.quality), r.founder_reviewed_at ? new Date(r.founder_reviewed_at) : null,
      r.reviewed_by, r.founder_note]);
  }
  return new NextResponse(new Uint8Array(buildXlsx([{ name: 'Calls to listen', rows: data }])), { headers: xlsxResponseHeaders(`rosier-calls-to-listen-${istDateStamp()}.xlsx`) });
}
