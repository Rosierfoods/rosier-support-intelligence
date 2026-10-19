import { NextResponse, type NextRequest } from 'next/server';
import { assertPermission, auditAction } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { getAgentReview, getCriticalAlerts, parseActivityFilters } from '@/lib/repos/activity';
import { buildXlsx, istDateStamp, searchParamsToSP, xlsxResponseHeaders, type XCell } from '@/lib/xlsx';

export const dynamic = 'force-dynamic';

const r1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

export async function GET(req: NextRequest) {
  let s;
  try {
    s = await assertPermission('reports.export');
    if (!s.permissions.has('reports.view')) throw new Error('forbidden');
  } catch {
    return NextResponse.json({ error: 'You do not have permission to export reports.' }, { status: 403 });
  }
  const f = parseActivityFilters(searchParamsToSP(req.nextUrl.searchParams), '30d');
  const session = s;
  const { rows, alerts } = await withOrg(session.org.id, async (db) => {
    const [rows, alerts] = await Promise.all([getAgentReview(db, session, f), getCriticalAlerts(db, session, f, 1000)]);
    await auditAction(db, session, 'export.agent_review', null, null, { row_count: rows.length });
    return { rows, alerts };
  });
  const review: XCell[][] = [['Agent', 'Team', 'Conversations', 'Calls', 'Scored', 'Quality (0-100)', 'Call quality (0-100)', 'Scored calls', 'Accuracy %',
    'Wrong information given', 'Policy violations', 'Critical alerts', 'High alerts', 'Confirmed alerts', 'Alerts waiting review', 'AI false positives',
    'Tickets', 'Tickets resolved', 'Refunds', 'Replacements', 'Escalated', 'Negative customers', 'Excellent (85+)', 'Poor (<60)']];
  for (const r of rows) {
    review.push([r.agent_name ?? 'Unassigned', r.team, r.interactions, r.calls, r.evaluated, r1(r.quality), r1(r.call_quality), r.call_evaluated,
      r.accuracy === null ? null : Math.round(r.accuracy * 1000) / 10, r.incorrect_statements, r.policy_violations, r.critical_alerts, r.high_alerts,
      r.confirmed_alerts, r.open_alerts, r.false_positives, r.tickets, r.resolved_tickets, r.refunds, r.replacements, r.escalations, r.negative_sentiment, r.excellent, r.poor]);
  }
  const crit: XCell[][] = [['When (IST)', 'Order ID', 'Interaction ID', 'Channel', 'Agent', 'Alert', 'Status']];
  for (const a of alerts) crit.push([new Date(a.created_at), a.order_ref, a.ref, a.channel, a.agent_name ?? 'Unassigned', a.title, a.status.replace(/_/g, ' ')]);
  const info: XCell[][] = [['Report', 'Agent review & accuracy'], ['Period', f.rangeLabel ?? ''], ['From', f.from], ['To', f.to], ['Generated', new Date()],
    ['Accuracy', 'Share of scored conversations where the agent gave no wrong information'], ['Quality', 'Average AI / human quality score of scored conversations']];
  return new NextResponse(new Uint8Array(buildXlsx([{ name: 'Agent review', rows: review }, { name: 'Critical alerts', rows: crit }, { name: 'Report info', rows: info, headerRows: 0 }])),
    { headers: xlsxResponseHeaders(`rosier-agent-review-${istDateStamp()}.xlsx`) });
}
