import Link from 'next/link';
import type { ReportColumn, ReportSection } from '@/lib/repos/reports';
import { ScoreBadge } from '@/components/badges';
import { fmtDate, fmtDateTime, fmtDuration, fmtINR, fmtNum, fmtPct, titleCase } from '@/lib/format';
import { fillHref } from './format';
import { CHANNEL_LABELS } from '@/lib/constants';

const RAW_TEXT = new Set(['ref', 'title', 'agent', 'team', 'name', 'product', 'reason', 'customer', 'rule', 'subcategory', 'category', 'issue', 'top_issue', 'confirmed_cause', 'replacement_statuses', 'resolution_requested', 'resolution_provided', 'reviewer', 'breach', 'sub_name']);

export function formatCell(col: ReportColumn, v: any) {
  if (v === null || v === undefined || v === '') return <span className="text-ink-faint">—</span>;
  switch (col.kind) {
    case 'num': return fmtNum(v);
    case 'dec': return fmtNum(v, 1);
    case 'pct': return fmtPct(v, 1);
    case 'dur': return fmtDuration(v);
    case 'date': return fmtDate(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v + 'T00:00:00+05:30' : v);
    case 'datetime': return fmtDateTime(v);
    case 'score': return <ScoreBadge score={v} />;
    case 'inr': return fmtINR(v);
    default:
      if (col.key === 'channel') return CHANNEL_LABELS[v as keyof typeof CHANNEL_LABELS] ?? String(v);
      return RAW_TEXT.has(col.key) ? String(v) : titleCase(String(v));
  }
}

export function ReportTable({ section }: { section: ReportSection }) {
  const numeric = (c: ReportColumn) => ['num', 'dec', 'pct', 'dur', 'inr', 'score'].includes(c.kind ?? '');
  const nowrap = (c: ReportColumn) => c.kind === 'date' || c.kind === 'datetime' || c.key === 'ref';
  return (
    <div className="overflow-x-auto scrollbar-thin print:overflow-visible">
      <table className="min-w-full divide-y divide-line text-sm">
        <thead className="bg-canvas/60"><tr>{section.columns.map((c) => <th key={c.key} scope="col" className={`th ${numeric(c) ? 'text-right' : ''}`}>{c.label}</th>)}</tr></thead>
        <tbody className="divide-y divide-line bg-white">
          {section.rows.map((r, i) => (
            <tr key={i} className="break-inside-avoid hover:bg-brand-50/40">
              {section.columns.map((c, j) => {
                const content = formatCell(c, r[c.key]);
                const href = c.href ? fillHref(c.href, r) : null;
                return (
                  <td key={c.key} className={`px-3 py-2 align-top ${numeric(c) ? 'whitespace-nowrap text-right tabular-nums' : ''} ${j === 0 ? 'font-medium text-ink' : ''} ${nowrap(c) ? 'whitespace-nowrap' : ''}`}>
                    {href && r[c.key] !== null && r[c.key] !== undefined ? <Link href={href} className="hover:text-brand hover:underline print:no-underline">{content}</Link> : content}
                  </td>
                );
              })}
            </tr>
          ))}
          {!section.rows.length && <tr><td colSpan={section.columns.length} className="px-3 py-6 text-center text-sm text-ink-muted">No records for these filters.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
