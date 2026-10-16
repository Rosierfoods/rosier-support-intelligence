import { NextResponse, type NextRequest } from 'next/server';
import { assertPermission, auditAction } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { getReport, parseReportFilters, sanitiseReportFilters, type ReportColumn } from '@/lib/repos/reports';
import { rateLimit } from '@/lib/auth/rate-limit';
import { fmtDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** Neutralise spreadsheet formula injection and quote per RFC 4180. */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rawValue(c: ReportColumn, v: any) {
  if (v === null || v === undefined || v === '') return '';
  if (c.kind === 'pct') return Math.round(Number(v) * 1000) / 10;
  if (c.kind === 'dur' || c.kind === 'num') return Math.round(Number(v));
  if (c.kind === 'dec' || c.kind === 'score' || c.kind === 'inr') return Math.round(Number(v) * 100) / 100;
  return v;
}

function header(c: ReportColumn) {
  return c.label + (c.kind === 'pct' ? ' (%)' : c.kind === 'dur' ? ' (seconds)' : c.kind === 'inr' ? ' (INR)' : '');
}

export async function GET(req: NextRequest, props: { params: Promise<{ report: string }> }) {
  const params = await props.params;
  let s;
  try { s = await assertPermission('reports.export'); } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Forbidden' }, { status: e.message === 'Not signed in' ? 401 : 403 });
  }
  const def = getReport(params.report);
  if (!def) return NextResponse.json({ error: 'Unknown report' }, { status: 404 });
  const rl = rateLimit(`export:${s.user.id}`, 30, 10 * 60_000);
  if (!rl.ok) return NextResponse.json({ error: 'Too many exports. Please wait a few minutes.' }, { status: 429 });

  const sp: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => { sp[k] = v; });
  const { range, f: rawF } = parseReportFilters(def, sp);

  try {
    const { csv, rows } = await withOrg(s.org.id, async (db) => {
      const f = await sanitiseReportFilters(db, s, rawF);
      const result = await def.run(db, s, f);
      const lines: string[] = [
        csvCell(`${def.title} — ${s.org.name}`),
        csvCell(`Date range (IST): ${fmtDateTime(range.from)} to ${fmtDateTime(range.to)}`),
        csvCell(`Sample size: ${result.sampleSize} ${result.sampleUnit}${result.hasDemo ? ' — includes DEMO DATA (synthetic)' : ''}`),
        ...result.notes.map((n) => csvCell(`Note: ${n}`)),
        csvCell(`Generated ${new Date().toISOString()} by ${s.user.email}`),
      ];
      let rows = 0;
      for (const sec of result.sections) {
        lines.push('', csvCell(sec.title) + (sec.truncated ? ',' + csvCell('(first 500 rows)') : ''));
        lines.push(sec.columns.map((c) => csvCell(header(c))).join(','));
        for (const r of sec.rows) { lines.push(sec.columns.map((c) => csvCell(rawValue(c, r[c.key]))).join(',')); rows++; }
      }
      const filters = Object.fromEntries(Object.entries({ ...f, from: range.from.toISOString(), to: range.to.toISOString() }).filter(([, v]) => v !== null && v !== undefined));
      await auditAction(db, s, 'export.report', 'report', def.key, { filters, row_count: rows, pii_unmasked: s.permissions.has('customer_pii.view') });
      return { csv: '﻿' + lines.join('\r\n') + '\r\n', rows };
    });
    const date = new Date().toISOString().slice(0, 10);
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="rsi-${def.key}-${date}.csv"`,
        'Cache-Control': 'no-store',
        'X-Row-Count': String(rows),
      },
    });
  } catch (e) {
    console.error('report export failed', def.key, e);
    return NextResponse.json({ error: 'Export failed' }, { status: 500 });
  }
}
