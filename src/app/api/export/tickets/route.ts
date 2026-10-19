import { NextResponse, type NextRequest } from 'next/server';
import { assertPermission, auditAction } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { exportTickets, parseTicketFilters, TICKET_EXPORT_MAX, TICKET_STATUS_LABELS } from '@/lib/repos/tickets';
import { RESOLUTION_TYPE_LABELS, type ResolutionType } from '@/lib/orders/tickets';
import { buildXlsx, istDateStamp, searchParamsToSP, xlsxResponseHeaders, type XCell } from '@/lib/xlsx';

export const dynamic = 'force-dynamic';

const HEAD = ['Order ID', 'Order check', 'Ticket ID', 'Interaction ID', 'Opened (IST)', 'Channel', 'Incoming / outgoing', 'Call status', 'Call duration (s)',
  'Customer name', 'Customer phone', 'Customer email', 'Agent', 'Issue category', 'Problem', 'What the agent did', 'Action type', 'Priority', 'Status',
  'Critical alerts', 'Quality score', 'Sentiment', 'AI summary', 'Closed (IST)', 'Edited by a person', 'Demo data'];

export async function GET(req: NextRequest) {
  let s;
  try {
    s = await assertPermission('reports.export');
    if (!s.permissions.has('interactions.view')) throw new Error('forbidden');
  } catch {
    return NextResponse.json({ error: 'You do not have permission to export tickets.' }, { status: 403 });
  }
  const f = parseTicketFilters(searchParamsToSP(req.nextUrl.searchParams));
  const session = s;
  const { rows, truncated } = await withOrg(session.org.id, async (db) => {
    const out = await exportTickets(db, session, f);
    await auditAction(db, session, 'export.tickets', 'support_ticket', null, { row_count: out.rows.length, truncated: out.truncated });
    return out;
  });
  const data: XCell[][] = [HEAD];
  for (const r of rows) {
    data.push([
      r.order_ref, !r.order_ref ? '' : r.order_verified ? 'Verified in Shopify' : 'Not verified', r.external_id, r.interaction_ref, new Date(r.opened_at),
      r.channel, r.direction ? (r.channel === 'call' ? (r.direction === 'outbound' ? 'Outgoing' : 'Incoming') : r.direction === 'outbound' ? 'Sent' : 'Received') : '',
      r.call_status, r.duration_seconds, r.customer_name, r.customer_phone, r.customer_email, r.agent_name ?? 'Unassigned', r.category, r.problem, r.action_taken,
      RESOLUTION_TYPE_LABELS[(r.resolution_type ?? 'none') as ResolutionType] ?? r.resolution_type, r.priority, TICKET_STATUS_LABELS[r.status] ?? r.status,
      r.critical_alerts, r.quality_score === null ? null : Number(r.quality_score), r.sentiment, r.summary, r.closed_at ? new Date(r.closed_at) : null,
      !r.auto_created, r.is_demo,
    ]);
  }
  if (truncated) data.push([`Export truncated at ${TICKET_EXPORT_MAX.toLocaleString('en-IN')} rows — narrow the filters to export the rest.`]);
  return new NextResponse(new Uint8Array(buildXlsx([{ name: 'Tickets', rows: data }])), { headers: xlsxResponseHeaders(`rosier-tickets-${istDateStamp()}.xlsx`) });
}
