import { NextResponse, type NextRequest } from 'next/server';
import { assertPermission, auditAction } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { parseRange } from '@/lib/filters';
import { getTalkTime, GST } from '@/lib/repos/talktime';
import { buildXlsx, istDateStamp, searchParamsToSP, xlsxResponseHeaders, type XCell } from '@/lib/xlsx';

export const dynamic = 'force-dynamic';

const hrs = (sec: number) => Math.round((sec / 3600) * 100) / 100;

export async function GET(req: NextRequest) {
  let s;
  try { s = await assertPermission('settings.manage'); } catch {
    return NextResponse.json({ error: 'You do not have permission to export this.' }, { status: 403 });
  }
  const range = parseRange(searchParamsToSP(req.nextUrl.searchParams), '30d');
  const session = s;
  const t = session.org.settings.transcription;
  const rate = Number(t.costPerMinuteInr ?? 0.49);
  const talk = await withOrg(session.org.id, async (db) => {
    const out = await getTalkTime(db, session, range, t);
    await auditAction(db, session, 'export.talk_time', null, null, { rows: out.rows.length });
    return out;
  });
  const data: XCell[][] = [['Agent', 'Calls', 'Answered', 'Incoming', 'Outgoing', 'Talk time (hours)', 'Calls to transcribe', 'Skipped (no agent / too short)',
    'Hours billed by Sarvam', 'Cost (₹, excl. GST)', 'Cost (₹, incl. GST)']];
  for (const r of [...talk.rows, talk.totals]) {
    const cost = (r.billable_seconds / 60) * rate;
    data.push([r === talk.totals ? 'All agents' : r.agent_name ?? 'Unassigned', r.calls, r.answered, r.incoming, r.outgoing, hrs(r.talk_seconds),
      r.to_transcribe, r.skipped, hrs(r.billable_seconds), Math.round(cost), Math.round(cost * (1 + GST))]);
  }
  const info: XCell[][] = [['Report', 'Talk time & transcription cost'], ['Period', range.label], ['From', range.from], ['To', range.to],
    ['Days with data', talk.days], ['Sarvam price (₹/min)', rate], ['Projected monthly cost (₹, incl. GST)', talk.monthlyCostGst],
    ['Rule', t.onlyAgentCalls ? `Only calls where an agent talked ≥ ${t.minAgentTalkSeconds}s are transcribed` : 'All answered calls are transcribed']];
  return new NextResponse(new Uint8Array(buildXlsx([{ name: 'Talk time', rows: data }, { name: 'Report info', rows: info, headerRows: 0 }])),
    { headers: xlsxResponseHeaders(`rosier-talk-time-${istDateStamp()}.xlsx`) });
}
