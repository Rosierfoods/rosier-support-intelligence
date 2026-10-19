import { NextResponse, type NextRequest } from 'next/server';
import { assertPermission, auditAction } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { getDailyActivity, parseActivityFilters, totalsByAgent } from '@/lib/repos/activity';
import { buildXlsx, istDateStamp, searchParamsToSP, xlsxResponseHeaders, type XCell } from '@/lib/xlsx';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  let s;
  try {
    s = await assertPermission('reports.export');
    if (!s.permissions.has('reports.view')) throw new Error('forbidden');
  } catch {
    return NextResponse.json({ error: 'You do not have permission to export reports.' }, { status: 403 });
  }
  const f = parseActivityFilters(searchParamsToSP(req.nextUrl.searchParams));
  const session = s;
  const rows = await withOrg(session.org.id, async (db) => {
    const out = await getDailyActivity(db, session, f);
    await auditAction(db, session, 'export.agent_activity', null, null, { row_count: out.length });
    return out;
  });
  const totals: XCell[][] = [['Agent', 'Active days', 'Incoming calls', 'Outgoing calls', 'Answered', 'Missed / not answered', 'Talk time (min)', 'Chats', 'Messages replied', 'Emails', 'Email replies', 'Total conversations', 'Avg per day']];
  for (const r of totalsByAgent(rows)) {
    totals.push([r.agent_name ?? 'Unassigned', r.days, r.calls_in, r.calls_out, r.answered, r.missed, Math.round(r.talk_seconds / 6) / 10, r.chats, r.chat_replies, r.emails, r.email_replies, r.total, Math.round((r.total / Math.max(1, r.days)) * 10) / 10]);
  }
  const daily: XCell[][] = [['Date', 'Agent', 'Incoming calls', 'Outgoing calls', 'Answered', 'Missed / not answered', 'Talk time (min)', 'Chats', 'Messages replied', 'Emails', 'Email replies', 'Total']];
  for (const r of rows) {
    daily.push([r.day, r.agent_name ?? 'Unassigned', r.calls_in, r.calls_out, r.answered, r.missed, Math.round(r.talk_seconds / 6) / 10, r.chats, r.chat_replies, r.emails, r.email_replies, r.total]);
  }
  const info: XCell[][] = [['Report', 'Agent daily activity'], ['Period', f.rangeLabel ?? ''], ['From', f.from], ['To', f.to], ['Generated', new Date()]];
  return new NextResponse(new Uint8Array(buildXlsx([{ name: 'Totals per agent', rows: totals }, { name: 'Day by day', rows: daily }, { name: 'Report info', rows: info, headerRows: 0 }])),
    { headers: xlsxResponseHeaders(`rosier-agent-activity-${istDateStamp()}.xlsx`) });
}
