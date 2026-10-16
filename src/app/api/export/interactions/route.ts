import { NextResponse, type NextRequest } from 'next/server';
import { assertPermission, auditAction } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import type { SP } from '@/lib/filters';
import { describeFilters, exportInteractions, EXPORT_MAX_ROWS, parseInteractionFilters } from '@/lib/repos/interactions';
import type { Channel } from '@/lib/constants';

export const dynamic = 'force-dynamic';

const PRESETS: Record<string, Channel[]> = { call: ['call'], chat: ['chat', 'whatsapp'], email: ['email'] };

const COLUMNS: [string, string][] = [
  ['ref', 'Interaction ID'], ['occurred_at', 'Date/time (IST)'], ['source_platform', 'Source platform'], ['channel', 'Channel'],
  ['direction', 'Direction'], ['customer_name', 'Customer name'], ['customer_phone', 'Customer phone'], ['customer_email', 'Customer email'],
  ['agent_name', 'Assigned agent'], ['team_name', 'Team'], ['call_status', 'Call status'], ['duration_seconds', 'Call duration (s)'],
  ['recording_available', 'Recording available'], ['subject', 'Subject'], ['ai_summary', 'AI summary (AI-generated)'],
  ['customer_intent', 'Customer intent (AI-generated)'], ['product', 'Product'], ['issue_category', 'Issue category'],
  ['issue_subcategory', 'Issue subcategory'], ['issue_labels', 'All issue labels'], ['sentiment', 'Sentiment'],
  ['quality_score', 'Quality score'], ['quality_band', 'Quality band'], ['detected_errors', 'Detected errors (alerts)'],
  ['recommended_improvement', 'Recommended improvement (AI-generated)'], ['first_response_seconds', 'First response (s)'],
  ['resolution_seconds', 'Resolution time (s)'], ['resolution_status', 'Resolution status'], ['ticket_ref', 'Linked ticket ID'],
  ['review_status', 'Review status'], ['processing_status', 'Processing status'], ['source_record_id', 'Source record ID'], ['is_demo', 'Demo data'],
];

const IST = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** RFC 4180 escaping + spreadsheet formula-injection guard. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? IST.format(v)
    : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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

  const lines = [COLUMNS.map(([, h]) => cell(h)).join(',')];
  for (const r of rows) lines.push(COLUMNS.map(([k]) => cell((r as Record<string, unknown>)[k])).join(','));
  if (truncated) lines.push(cell(`Export truncated at ${EXPORT_MAX_ROWS.toLocaleString('en-IN')} rows — narrow the filters to export the rest.`));
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  return new NextResponse('﻿' + lines.join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="rosier-interactions-${date}.csv"`,
      'Cache-Control': 'no-store',
      'X-Export-Rows': String(rows.length),
    },
  });
}
