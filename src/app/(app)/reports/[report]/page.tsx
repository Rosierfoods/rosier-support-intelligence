import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { withParams, type SP } from '@/lib/filters';
import { getFilterOptions } from '@/lib/repos/analytics';
import { getReport, parseReportFilters, sanitiseReportFilters } from '@/lib/repos/reports';
import { Card, CardHeader, DemoBadge, Notice, buttonClass } from '@/components/ui';
import { ClearFilters, ParamSelect, RangeFilter } from '@/components/filters';
import { PrintButton } from '@/components/analytics/PrintButton';
import { ReportTable } from '@/components/analytics/ReportTable';
import { CHANNELS, CHANNEL_LABELS, SEVERITIES } from '@/lib/constants';
import { fmtDate, fmtDateTime, titleCase } from '@/lib/format';
import { ChevronLeft, Download } from 'lucide-react';

export async function generateMetadata(props: { params: Promise<{ report: string }> }) {
  const params = await props.params;
  return { title: getReport(params.report)?.title ?? 'Report' };
}

// Print layout: hide app chrome and controls, full-width tables, avoid splitting rows.
const PRINT_CSS = `
@media print {
  @page { size: A4 landscape; margin: 12mm; }
  aside, header, nav, .print-hide, button[aria-label="Open menu"] { display: none !important; }
  body { background: #fff !important; }
  .lg\\:pl-60 { padding-left: 0 !important; }
  main { max-width: none !important; padding: 0 !important; }
  .card { box-shadow: none !important; break-inside: auto; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  a { color: inherit !important; text-decoration: none !important; }
  div[class*="bg-amber-50"][class*="border-b"] { display: none !important; }
}`;

export default async function ReportPage(props: { params: Promise<{ report: string }>; searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const s = await requirePermission('reports.view');
  const def = getReport(params.report);
  if (!def) notFound();
  const { range, f: rawF } = parseReportFilters(def, searchParams);

  const { result, opts, f } = await withOrg(s.org.id, async (db) => {
    const f = await sanitiseReportFilters(db, s, rawF);
    const [result, opts] = await Promise.all([def.run(db, s, f), getFilterOptions(db, s)]);
    return { result, opts, f };
  });
  const has = (k: string) => def.filters.includes(k as any);
  const generated = new Date();
  const qs = withParams(searchParams, {});
  const activeFilters = [
    f.channel && `Channel: ${CHANNEL_LABELS[f.channel]}`,
    f.teamId && `Team: ${opts.teams.find((t) => t.id === f.teamId)?.name ?? '—'}`,
    f.agentId && `Agent: ${opts.agents.find((a) => a.id === f.agentId)?.name ?? '—'}`,
    f.category && `Category: ${opts.categories.find((c) => c.code === f.category)?.name ?? f.category}`,
    f.product && `Product: ${f.product}`,
    f.severity && `Severity: ${titleCase(f.severity)}`,
  ].filter(Boolean) as string[];

  return (
    <div className="space-y-4">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      <div className="print-hide flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <Link href="/reports" className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-brand"><ChevronLeft size={14} aria-hidden /> All reports</Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink">{def.title}</h1>
          <p className="mt-0.5 text-sm text-ink-muted">{def.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {s.permissions.has('reports.export') && (
            <a href={`/api/reports/${def.key}${qs}`} className={buttonClass('secondary', 'sm')} download>
              <Download size={14} aria-hidden /> Download CSV
            </a>
          )}
          <PrintButton />
        </div>
      </div>
      <div className="print-hide flex flex-wrap items-center gap-2">
        {has('channel') && <ParamSelect name="channel" placeholder="All channels" options={CHANNELS.filter((c) => def.key !== 'text-quality' || c !== 'call').map((c) => ({ value: c, label: CHANNEL_LABELS[c] }))} />}
        {has('team') && opts.teams.length > 1 && <ParamSelect name="team" placeholder="All teams" options={opts.teams.map((t) => ({ value: t.id, label: t.name }))} />}
        {has('agent') && <ParamSelect name="agent" placeholder="All agents" options={opts.agents.map((a) => ({ value: a.id, label: a.name }))} />}
        {has('category') && <ParamSelect name="category" placeholder="All issue categories" options={opts.categories.map((c) => ({ value: c.code, label: c.name }))} />}
        {has('product') && <ParamSelect name="product" placeholder="All products" options={opts.products.map((p) => ({ value: p, label: p }))} />}
        {has('severity') && <ParamSelect name="severity" placeholder="All severities" options={SEVERITIES.map((v) => ({ value: v, label: titleCase(v) }))} />}
        <RangeFilter defaultPreset={def.defaultRange} />
        <ClearFilters />
      </div>

      {/* Report header — always printed */}
      <Card>
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-2xs font-semibold uppercase tracking-wide text-ink-faint">{s.org.name} · Rosier Support Intelligence</p>
            <h2 className="text-base font-semibold text-ink">{def.title}</h2>
            <p className="mt-1 text-sm text-ink">
              <span className="font-medium">{fmtDate(range.from)} – {fmtDate(range.to)}</span> <span className="text-ink-muted">(IST · {range.label})</span>
            </p>
            <p className="mt-0.5 text-xs text-ink-muted">Filters: {activeFilters.length ? activeFilters.join(' · ') : 'none'}{s.scope !== 'all' && ' · limited to your team'}</p>
          </div>
          <div className="shrink-0 text-left sm:text-right">
            <p className="text-2xl font-semibold tabular-nums text-ink">{result.sampleSize.toLocaleString('en-IN')}</p>
            <p className="text-xs text-ink-muted">n = {result.sampleUnit}</p>
            {result.hasDemo && <div className="mt-1"><DemoBadge /></div>}
            <p className="mt-1 text-2xs text-ink-faint">Generated {fmtDateTime(generated)} by {s.user.name}</p>
          </div>
        </div>
        {result.notes.length > 0 && (
          <ul className="space-y-0.5 border-t border-line px-4 py-2 text-2xs text-ink-muted">{result.notes.map((n) => <li key={n}>• {n}</li>)}</ul>
        )}
      </Card>
      {result.hasDemo && <Notice tone="warn" className="print:border-amber-300">This report includes synthetic DEMO DATA. Do not use it for business decisions.</Notice>}

      {result.sections.map((sec) => (
        <Card key={sec.title} className="break-inside-auto">
          <CardHeader title={sec.title} subtitle={<>{sec.description ? `${sec.description} · ` : ''}{sec.rows.length.toLocaleString('en-IN')} rows{sec.truncated ? ' (limited to the first 500 — narrow the filters to see the rest)' : ''}</>} />
          <ReportTable section={sec} />
        </Card>
      ))}
      <p className="text-2xs text-ink-faint">Click any linked value to open the underlying records. Computed from stored records for the filters above and your data scope.</p>
    </div>
  );
}
