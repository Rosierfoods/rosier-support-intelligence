import Link from 'next/link';
import { requirePermission } from '@/lib/auth/session';
import { withOrg, isUuid } from '@/lib/db';
import { parseChannel, parseRange, sp, withParams, type SP } from '@/lib/filters';
import {
  ISSUE_METRIC_DEFS, DAMAGED_SUBS, COMPARE_MIN_CURRENT, COMPARE_MIN_PREVIOUS, getCategoryTrend, getFilterOptions, getIssueKpis, getIssuesByAgent,
  getIssuesByChannel, getIssuesByProduct, getIssuesBySource, getIssuesByVariant, getPareto, getPeriodComparisons, getRootCauses,
  getTopReasons, type AFilters,
} from '@/lib/repos/analytics';
import { Badge, Card, CardBody, CardHeader, DemoBadge, KpiCard, Notice, PageHeader, Table, TBody, THead } from '@/components/ui';
import { ChartCard, HBarList } from '@/components/charts';
import { ClearFilters, ParamSelect, RangeFilter } from '@/components/filters';
import { DrillLines } from '@/components/analytics/DrillLines';
import { ParetoList } from '@/components/analytics/ParetoList';
import { Segmented } from '@/components/analytics/Segmented';
import { SampleNote } from '@/components/analytics/SampleNote';
import { bucketEnd, bucketLabel, istDate, pctChange } from '@/components/analytics/format';
import { SERIES, WARN_COLOR } from '@/lib/palette';
import { CHANNELS, CHANNEL_LABELS, PLATFORM_LABELS } from '@/lib/constants';
import { fmtDate, fmtDuration, fmtINR, fmtNum, fmtPct } from '@/lib/format';

export const metadata = { title: 'Customer Issues & Root Causes' };

// Five distinguishable line colours (brand + validated channel hues), legend always shown.
const LINE_COLORS = ['#784900', SERIES.chat, SERIES.whatsapp, SERIES.email, WARN_COLOR];

export default async function IssuesPage(props: { searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const s = await requirePermission('reports.view');
  const range = parseRange(searchParams);
  const channel = parseChannel(searchParams);
  const agentParam = sp(searchParams, 'agent');
  const f: AFilters = {
    from: range.from, to: range.to, channel,
    product: sp(searchParams, 'product') ?? null,
    agentId: agentParam && isUuid(agentParam) ? agentParam : null,
    category: sp(searchParams, 'category') ?? null,
  };
  const bucketParam = sp(searchParams, 'bucket');
  const bucket = (['day', 'week', 'month'].includes(bucketParam ?? '') ? bucketParam : range.days <= 31 ? 'day' : range.days <= 120 ? 'week' : 'month') as 'day' | 'week' | 'month';
  const period = sp(searchParams, 'period') === 'month' ? 'month' : 'week';
  const periodDays = period === 'month' ? 30 : 7;

  const d = await withOrg(s.org.id, async (db) => {
    const [opts, kpis, pareto, trend, byProduct, byVariant, byChannel, byAgent, bySource, reasons, roots, cmp] = await Promise.all([
      getFilterOptions(db, s), getIssueKpis(db, s, f), getPareto(db, s, f), getCategoryTrend(db, s, f, bucket),
      getIssuesByProduct(db, s, f), getIssuesByVariant(db, s, f), getIssuesByChannel(db, s, f), getIssuesByAgent(db, s, f),
      getIssuesBySource(db, s, f), getTopReasons(db, s, f), getRootCauses(db, s, f), getPeriodComparisons(db, s, f, periodDays, range.to),
    ]);
    return { opts, kpis, pareto, trend, byProduct, byVariant, byChannel, byAgent, bySource, reasons, roots, cmp };
  });
  const k = d.kpis;

  // Drill-down: every link carries the active filters so /inbox shows exactly the matching conversations.
  const baseQ = {
    range: sp(searchParams, 'range'), from: sp(searchParams, 'from'), to: sp(searchParams, 'to'), channel: channel ?? undefined,
    product: f.product ?? undefined, agent: f.agentId ?? undefined, category: f.category ?? undefined,
  };
  const inbox = (extra: Record<string, string | undefined>) => `/inbox${withParams(baseQ as SP, extra)}`;
  const trendHref = `/inbox${withParams({ ...baseQ, range: undefined, from: undefined, to: undefined } as SP, {})}`;
  const trendTemplate = `${trendHref}${trendHref.includes('?') ? '&' : '?'}from={bucket}&to={bucket_end}&category={series}`;

  const trendRows: Record<string, any>[] = d.trend.series.map((r) => ({ ...r, label: bucketLabel(r.bucket, bucket), bucket_end: bucketEnd(r.bucket, bucket) }));
  const statusCount = (st: string) => d.roots.counts.find((c) => c.status === st);
  const sufficient = d.cmp.items.filter((c) => c.sufficient);
  const insufficient = d.cmp.items.filter((c) => !c.sufficient).slice(0, Math.max(0, 8 - sufficient.length));
  const window = (w: { from: Date; to: Date }) => `${fmtDate(w.from)} – ${fmtDate(w.to)}`;
  const financial = k.refund_value_n > 0 || k.replacement_value_n > 0;

  return (
    <div className="space-y-5">
      <PageHeader title="Customer Issues & Root Causes"
        description={<>What customers contact us about, for <span className="font-medium text-ink">{range.label}</span>{k.has_demo && <> · <DemoBadge /></>}</>}
        actions={<>
          <ParamSelect name="channel" placeholder="All channels" options={CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] }))} />
          <ParamSelect name="category" placeholder="All categories" options={d.opts.categories.map((c) => ({ value: c.code, label: c.name }))} />
          <ParamSelect name="product" placeholder="All products" options={d.opts.products.map((p) => ({ value: p, label: p }))} />
          <ParamSelect name="agent" placeholder="All agents" options={d.opts.agents.map((a) => ({ value: a.id, label: a.name }))} />
          <RangeFilter />
          <ClearFilters />
        </>} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        <KpiCard label="Refund requests" value={fmtNum(k.refunds)} formula={ISSUE_METRIC_DEFS.refunds} href={inbox({ category: 'refund' })} />
        <KpiCard label="Replacement requests" value={fmtNum(k.replacements)} formula={ISSUE_METRIC_DEFS.replacements} href={inbox({ category: 'replacement' })} />
        <KpiCard label="Ghee leakage complaints" value={fmtNum(k.ghee_leak)} formula={ISSUE_METRIC_DEFS.ghee_leak} href={inbox({ category: 'quality', subcategory: 'quality.ghee_leak' })} />
        <KpiCard label="Damaged-product complaints" value={fmtNum(k.damaged)} formula={ISSUE_METRIC_DEFS.damaged} sub="Damaged · packaging · broken jar" href={inbox({ subcategory: DAMAGED_SUBS.join(',') })} />
        <KpiCard label="Delivery complaints" value={fmtNum(k.delivery)} formula={ISSUE_METRIC_DEFS.delivery} href={inbox({ category: 'delivery' })} />
        <KpiCard label="Resolved on first contact" value={fmtPct(k.fcr)} sub={`of ${fmtNum(k.resolved_n)} resolved complaints`} formula={ISSUE_METRIC_DEFS.fcr} href={inbox({ complaints: '1', resolution: 'resolved' })} />
        <KpiCard label="Avg time to resolution" value={fmtDuration(k.avg_resolution)} sub="Resolved complaints" formula={ISSUE_METRIC_DEFS.avg_resolution} />
        <KpiCard label="Repeat complainers" value={fmtNum(k.repeat_customers)} sub={`${fmtNum(k.repeat_contacts)} repeat-contact interactions`} formula={ISSUE_METRIC_DEFS.repeat} tone={k.repeat_customers > 0 ? 'warn' : undefined} />
        <KpiCard label="Refund value" value={k.refund_value_n ? fmtINR(k.refund_value) : 'No records'} sub={k.refund_value_n ? `${k.refund_value_n} recorded refunds` : 'No financial records connected'} formula={ISSUE_METRIC_DEFS.refund_value} />
        <KpiCard label="Replacement-case value" value={k.replacement_value_n ? fmtINR(k.replacement_value) : 'No records'} sub={k.replacement_value_n ? `${k.replacement_value_n} recorded amounts` : 'No financial records connected'} formula={ISSUE_METRIC_DEFS.refund_value} />
      </div>
      <SampleNote n={k.complaints} unit={`complaint interactions (of ${fmtNum(k.interactions)} in range)`} from={range.from} to={range.to} demo={k.has_demo}>
        {!financial && <span className="text-ink-faint">· Values are shown only when a refund amount is backed by a financial record.</span>}
      </SampleNote>

      {/* Period-over-period summary */}
      <Card>
        <CardHeader title={`${period === 'month' ? 'Monthly' : 'Weekly'} summary`}
          subtitle={<>Last {periodDays} days ({window(d.cmp.current)}) vs the previous {periodDays} days ({window(d.cmp.previous)})</>}
          actions={<Segmented basePath="/issues" searchParams={searchParams} name="period" label="Summary period" value={period}
            options={[{ value: 'week', label: 'Weekly' }, { value: 'month', label: 'Monthly' }]} />} />
        <CardBody className="space-y-3">
          {sufficient.length === 0 && (
            <Notice tone="info" title="Not enough data to compare">
              No issue reached the minimum sample (≥{COMPARE_MIN_CURRENT} interactions in the current window and ≥{COMPARE_MIN_PREVIOUS} in the previous window), so no trend statements are generated.
            </Notice>
          )}
          <ul className="divide-y divide-line">
            {sufficient.map((c) => {
              const up = (c.change ?? 0) > 0;
              const flat = c.change !== null && Math.abs(c.change) < 0.005;
              return (
                <li key={c.kind + c.code} className="py-2">
                  <p className="text-sm text-ink">
                    <Link className="font-medium hover:text-brand hover:underline"
                      href={inbox({ range: undefined, from: istDate(d.cmp.current.from), to: istDate(d.cmp.current.to), category: c.cat_code, subcategory: c.kind === 'subcategory' ? c.code : undefined })}>
                      {c.name}
                    </Link>{' '}
                    complaints{' '}
                    {flat ? 'were unchanged' : <>{up ? 'increased' : 'decreased'} by <span className={up ? 'font-semibold text-amber-800' : 'font-semibold text-emerald-800'}>{pctChange(c.change).replace('+', '').replace('-', '')}</span></>}{' '}
                    compared with the previous {periodDays} days.
                  </p>
                  <p className="text-2xs text-ink-muted">
                    n = {c.current} (current) vs {c.previous} (previous) · {c.kind === 'category' ? 'Category' : 'Subcategory'} · Method: distinct interactions with an active label, equal-length windows, same filters.
                  </p>
                </li>
              );
            })}
            {insufficient.map((c) => (
              <li key={c.kind + c.code} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span className="text-sm text-ink-muted">{c.name} <span className="text-2xs text-ink-faint">({c.kind})</span></span>
                <span className="text-2xs text-ink-faint">Not enough data to compare · n = {c.current} vs {c.previous}</span>
              </li>
            ))}
          </ul>
          <p className="text-2xs text-ink-faint" title={ISSUE_METRIC_DEFS.comparison}>
            Statements require ≥{COMPARE_MIN_CURRENT} interactions in the current window and ≥{COMPARE_MIN_PREVIOUS} in the previous one. Windows end at the selected range’s end date; other filters apply.
          </p>
        </CardBody>
      </Card>

      <div className="grid gap-4 xl:grid-cols-5">
        <ChartCard className="xl:col-span-2" title="Pareto of complaint subcategories" subtitle={`${fmtNum(d.pareto.total)} subcategory labels · click a row to open the conversations`}
          actions={<span title={ISSUE_METRIC_DEFS.pareto} className="cursor-help text-2xs text-ink-faint">ⓘ</span>}
          table={{ columns: ['Subcategory', 'Category', 'Interactions', 'Share', 'Cumulative'], rows: d.pareto.rows.map((r) => [r.sub_name ?? r.cat_name, r.cat_name, r.n, fmtPct(r.share), fmtPct(r.cumulative)]) }}>
          <ParetoList rows={d.pareto.rows.slice(0, 15).map((r) => ({
            label: r.sub_name ?? r.cat_name, sub: r.cat_name, n: r.n, share: r.share, cumulative: r.cumulative,
            href: inbox({ category: r.cat_code, subcategory: r.sub_code ?? undefined }),
          }))} />
          {d.pareto.rows.length > 15 && <p className="mt-2 text-2xs text-ink-faint">Showing top 15 of {d.pareto.rows.length}; switch to the table view for all.</p>}
        </ChartCard>
        <ChartCard className="xl:col-span-3" title="Issue trend by top categories" subtitle={`Distinct interactions per ${bucket} · click a point to open that ${bucket}'s conversations`}
          actions={<ParamSelect name="bucket" placeholder={`By ${bucket}`} options={[{ value: 'day', label: 'By day' }, { value: 'week', label: 'By week' }, { value: 'month', label: 'By month' }]} />}
          table={{ columns: ['Period', ...d.trend.top.map((t) => t.name)], rows: trendRows.map((r) => [r.label, ...d.trend.top.map((t) => r[t.code] ?? 0)]) }}>
          <DrillLines data={trendRows} xKey="label" hrefTemplate={trendTemplate}
            series={d.trend.top.map((t, i) => ({ key: t.code, label: t.name, color: LINE_COLORS[i % LINE_COLORS.length] }))} />
        </ChartCard>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <ChartCard title="Issue frequency by product" subtitle="Complaint interactions · sub = quality-related"
          table={{ columns: ['Product', 'Complaints', 'Quality', 'Refund/replacement'], rows: d.byProduct.map((r: any) => [r.label, r.n, r.quality_n, r.refund_repl_n]) }}>
          <HBarList rows={d.byProduct.map((r: any) => ({ label: r.label, value: r.n, sub: `${r.quality_n} quality`, href: inbox({ product: r.key === 'Unknown' ? undefined : r.key, complaints: '1' }) }))} />
        </ChartCard>
        <ChartCard title="Issue frequency by product variant" subtitle="Only labels where a variant was identified"
          table={d.byVariant.length ? { columns: ['Product · variant', 'Complaints'], rows: d.byVariant.map((r: any) => [r.label, r.n]) } : undefined}>
          {d.byVariant.length
            ? <HBarList rows={d.byVariant.map((r: any) => ({ label: r.label, value: r.n, href: inbox({ product: String(r.label).split(' · ')[0], complaints: '1' }) }))} />
            : <div className="flex h-40 flex-col items-center justify-center text-center text-sm text-ink-muted"><p>No variant data recorded.</p><p className="mt-1 text-2xs text-ink-faint">Variants appear once the AI or a reviewer identifies pack size / variant on an issue label.</p></div>}
        </ChartCard>
        <ChartCard title="Issue frequency by channel" subtitle="Complaint interactions per channel"
          table={{ columns: ['Channel', 'Complaints', 'Quality', 'Refund/replacement'], rows: d.byChannel.map((r: any) => [CHANNEL_LABELS[r.key as keyof typeof CHANNEL_LABELS] ?? r.key, r.n, r.quality_n, r.refund_repl_n]) }}>
          <HBarList rows={d.byChannel.map((r: any) => ({
            label: CHANNEL_LABELS[r.key as keyof typeof CHANNEL_LABELS] ?? r.key, value: r.n, sub: `${r.refund_repl_n} refund/repl.`,
            color: SERIES[r.key as keyof typeof SERIES], href: inbox({ channel: r.key, complaints: '1' }),
          }))} />
        </ChartCard>
        <ChartCard title="Issue frequency by agent" subtitle="Complaint interactions handled — reflects case assignment, not fault"
          table={{ columns: ['Agent', 'Complaints', 'Quality', 'Refund/replacement'], rows: d.byAgent.map((r: any) => [r.label, r.n, r.quality_n, r.refund_repl_n]) }}>
          <HBarList rows={d.byAgent.map((r: any) => ({ label: r.label, value: r.n, sub: `${r.quality_n} quality`, href: r.key ? inbox({ agent: r.key, complaints: '1' }) : undefined }))} />
        </ChartCard>
        <ChartCard title="Issue frequency by order source" subtitle="By source platform of the conversation"
          table={{ columns: ['Source', 'Complaints'], rows: d.bySource.map((r: any) => [PLATFORM_LABELS[r.key] ?? r.key, r.n]) }}>
          <HBarList rows={d.bySource.map((r: any) => ({ label: PLATFORM_LABELS[r.key] ?? r.key, value: r.n, href: inbox({ platform: r.key, complaints: '1' }) }))} />
        </ChartCard>
        <ChartCard title="Top customer-reported reasons" subtitle="Customer’s own stated reason, grouped · opens the most common subcategory"
          table={{ columns: ['Reason', 'Interactions', 'Most common subcategory'], rows: d.reasons.map((r: any) => [r.reason, r.n, r.sub_name ?? '—']) }}>
          <HBarList rows={d.reasons.map((r: any) => ({ label: r.reason, value: r.n, sub: r.sub_name ?? undefined, href: inbox({ category: r.cat_code, subcategory: r.sub_code ?? undefined }) }))} />
        </ChartCard>
      </div>

      <Card>
        <CardHeader title="Confirmed vs suspected root causes"
          subtitle="Suspected causes are AI inferences and stay labelled as such until a person confirms them with evidence. A leaking jar is never attributed to packaging, transport or manufacturing without supporting evidence." />
        <div className="grid grid-cols-3 divide-x divide-line border-b border-line">
          {(['confirmed', 'suspected', 'rejected'] as const).map((st) => (
            <div key={st} className="px-4 py-3">
              <p className="text-xs font-medium capitalize text-ink-muted">{st}</p>
              <p className="text-xl font-semibold tabular-nums text-ink">{fmtNum(statusCount(st)?.n ?? 0)}</p>
              <p className="text-2xs text-ink-faint">{fmtNum(statusCount(st)?.interactions ?? 0)} interactions</p>
            </div>
          ))}
        </div>
        <Table>
          <THead><tr><th className="th">Root cause</th><th className="th">Status</th><th className="th">Issue</th><th className="th">Interactions</th><th className="th">Latest</th><th className="th"><span className="sr-only">Open</span></th></tr></THead>
          <TBody>
            {d.roots.list.map((r: any, i: number) => (
              <tr key={i} className="hover:bg-brand-50/40">
                <td className="td max-w-md">
                  <p className="text-ink">{r.cause}</p>
                  {r.status === 'suspected' && <p className="mt-0.5 text-2xs text-ink-faint">Not verified — requires Quality/Ops confirmation.</p>}
                </td>
                <td className="td whitespace-nowrap">
                  {r.status === 'confirmed' ? <Badge tone="good">Confirmed</Badge> : r.status === 'rejected' ? <Badge tone="muted">Rejected</Badge> : <Badge tone="warn">Suspected</Badge>}
                  {r.ai && r.status !== 'confirmed' && <Badge tone="info" className="ml-1">AI inference</Badge>}
                </td>
                <td className="td text-xs"><Link className="hover:text-brand hover:underline" href={inbox({ category: r.cat_code, subcategory: r.sub_code ?? undefined })}>{r.sub_name ?? r.cat_code}</Link></td>
                <td className="td tabular-nums">{r.n}</td>
                <td className="td whitespace-nowrap text-xs text-ink-muted">{fmtDate(r.last_at)}</td>
                <td className="td text-right"><Link className="text-xs text-brand hover:underline" href={`/inbox/${r.example_id}`}>Latest case →</Link></td>
              </tr>
            ))}
            {!d.roots.list.length && <tr><td className="td text-ink-muted" colSpan={6}>No root causes recorded for these filters.</td></tr>}
          </TBody>
        </Table>
      </Card>
      <p className="text-2xs text-ink-faint">All figures are computed from stored issue labels for the selected filters and your data scope. Hover the ⓘ icons for formulas.</p>
    </div>
  );
}
