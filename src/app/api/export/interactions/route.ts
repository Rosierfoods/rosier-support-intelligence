import { NextResponse, type NextRequest } from 'next/server';
import { assertPermission, auditAction } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import type { SP } from '@/lib/filters';
import { describeFilters, exportInteractions, EXPORT_MAX_ROWS, parseInteractionFilters } from '@/lib/repos/interactions';
import type { Channel } from '@/lib/constants';
import { buildXlsx, xlsxResponseHeaders, type XCell } from '@/lib/xlsx';

export const dynamic = 'force-dynamic';

const PRESETS: Record<string, Channel[]> = { call: ['call'], chat: ['chat', 'whatsapp'], email: ['email'] };

const COLUMNS: [string, string][] = [
  ['order_ref', 'Order ID'], ['order_status', 'Order check'], ['ref', 'Interaction ID'], ['occurred_at', 'Date/time (IST)'],
  ['channel', 'Channel'], ['direction', 'Incoming / outgoing'], ['source_platform', 'Source platform'],
  ['customer_name', 'Customer name'], ['customer_phone', 'Customer phone'], ['customer_email', 'Customer email'],
  ['agent_name', 'Agent'], ['team_name', 'Team'], ['call_status', 'Call status'], ['duration_seconds', 'Call duration (s)'],
  ['recording_available', 'Recording available'], ['issue_category', 'Issue category'], ['issue_subcategory', 'Issue subcategory'],
  ['issue_labels', 'All issue labels'], ['product', 'Product'], ['ticket_problem', 'Problem (ticket)'], ['ticket_action', 'What the agent did'],
  ['ticket_resolution_type', 'Action type'], ['ticket_priority', 'Ticket priority'], ['ticket_status', 'Ticket status'], ['ticket_ref', 'Ticket ID'],
  ['ai_summary', 'AI summary'], ['customer_intent', 'Customer intent'], ['sentiment', 'Sentiment'],
  ['quality_score', 'Quality score'], ['quality_band', 'Quality band'], ['detected_errors', 'Alerts / detected errors'],
  ['recommended_improvement', 'Recommended improvement'], ['first_response_seconds', 'First response (s)'],
  ['resolution_seconds', 'Resolution time (s)'], ['resolution_status', 'Resolution status'], ['subject', 'Subject'],
  ['review_status', 'Review status'], ['processing_status', 'Processing status'], ['source_record_id', 'Source record ID'], ['is_demo', 'Demo data'],
];

function value(r: Record<string, any>, k: string): XCell {
  if (k === 'direction') return r.channel === 'call' ? (r.direction === 'outbound' ? 'Outgoing' : 'Incoming') : r.direction === 'outbound' ? 'Sent' : 'Received';
  if (k === 'order_status') return !r.order_ref ? '' : r.order_verified ? 'Verified in Shopify' : r.order_source === 'manual' ? 'Entered manually' : 'From conversation (unverified)';
  if (k === 'quality_score') return r.quality_score === null || r.quality_score === undefined ? null : Number(r.quality_score);
  const v = r[k];
  return v instanceof Date || typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined ? v : String(v);
}

export async function GET(req: NextRequest) {
  let s;
  try {
    s = await assertPermission('reports.export');
    if (!s.permissions.has('interactions.view')) throw new Error('forbidden');
  } catch {
    return NextResponse.json({ error: 'You do not have permission to export interactions.' }, { status: 403 });
  }
  const searchParams: SP = {};
  req.nextUrl.searchParams.forEach((v, k) => {
    const cur = searchParams[k];
    searchParams[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  });
  const preset = PRESETS[req.nextUrl.searchParams.get('preset') ?? ''];
  const f = parseInteractionFilters(searchParams, { presetChannels: preset });

  const session = s;
  const { rows, truncated } = await withOrg(session.org.id, async (db) => {
    const out = await exportInteractions(db, session, f);
    await auditAction(db, session, 'export.interactions', 'interaction', null, {
      filters: describeFilters(f), row_count: out.rows.length, truncated: out.truncated, pii_unmasked: session.permissions.has('customer_pii.view'),
    });
    return out;
  });

  const data: XCell[][] = [COLUMNS.map(([, h]) => h)];
  for (const r of rows) data.push(COLUMNS.map(([k]) => value(r as Record<string, any>, k)));
  if (truncated) data.push([`Export truncated at ${EXPORT_MAX_ROWS.toLocaleString('en-IN')} rows — narrow the filters to export the rest.`]);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const name = preset === PRESETS.call ? 'calls' : preset === PRESETS.chat ? 'chats' : preset === PRESETS.email ? 'emails' : 'interactions';
  return new NextResponse(new Uint8Array(buildXlsx([{ name: name[0].toUpperCase() + name.slice(1), rows: data }])), {
    headers: { ...xlsxResponseHeaders(`rosier-${name}-${date}.xlsx`), 'X-Export-Rows': String(rows.length) },
  });
}
