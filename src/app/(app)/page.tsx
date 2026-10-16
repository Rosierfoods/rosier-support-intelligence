import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { parseChannel, parseRange, sp, withParams, type SP } from '@/lib/filters';
import {
  METRIC_DEFS, getIssueDistribution, getKpis, getLeaderboard, getOperational, getProductComplaints, getRecentFlags,
  getSentimentSeries, getVolumeSeries, type DashboardFilters,
} from '@/lib/metrics/dashboard';
import { Card, CardHeader, DemoBadge, KpiCard, PageHeader, Table, TBody, THead } from '@/components/ui';
import { ChartCard, ColumnBars, HBarList, Lines, StackedBars } from '@/components/charts';
import { SENTIMENT_COLORS, SERIES } from '@/lib/palette';
import { ParamSelect, RangeFilter } from '@/components/filters';
import { ChannelBadge, FlagStatusBadge, ScoreBadge, SeverityBadge } from '@/components/badges';
import { fmtDuration, fmtNum, fmtPct, relTime } from '@/lib/format';
import { CHANNELS, CHANNEL_LABELS } from '@/lib/constants';

export const metadata = { title: 'Overview' };

function bucketLabel(b: string, bucket: string) {
  const d = new Date(b + 'T00:00:00');
  if (bucket === 'month') return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

function bucketEnd(b: string, bucket: string) {
  const d = new Date(b + 'T00:00:00Z');
  if (bucket === 'week') d.setUTCDate(d.getUTCDate() + 6);
  else if (bucket === 'month') { d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); }
  return d.toISOString().slice(0, 10);
}

export default async function OverviewPage(props: { searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const s = await requireSession();
  if (!s.permissions.has('dashboard.view')) redirect(s.user.role === 'support_agent' ? '/agents/me' : '/inbox');
  const range = parseRange(searchParams);
  const channel = parseChannel(searchParams);
  const bucketParam = sp(searchParams, 'bucket');
  const bucket = (['day', 'week', 'month'].includes(bucketParam ?? '') ? bucketParam : range.days <= 31 ? 'day' : range.days <= 120 ? 'week' : 'month') as DashboardFilters['bucket'];
  const f: DashboardFilters = { from: range.from, to: range.to, channel, bucket };

  const data = await withOrg(s.org.id, async (db) => {
    const [kpis, volume, sentiment, issues, leaders, flags, products, ops] = await Promise.all([
      getKpis(db, s, f), getVolumeSeries(db, s, f), getSentimentSeries(db, s, f), getIssueDistribution(db, s, f),
      getLeaderboard(db, s, f), getRecentFlags(db, s, f), getProductComplaints(db, s, f), getOperational(db, s, f),
    ]);
    return { kpis, volume, sentiment, issues, leaders, flags, products, ops };
  });
  const k = data.kpis;
  const qs = (extra: Record<string, string | undefined>) => withParams({ range: searchParams.range, from: searchParams.from, to: searchParams.to, channel: searchParams.channel }, extra);

  // issue distribution by category (an interaction can carry several categories)
  const catTotals = new Map<string, { name: string; n: number }>();
  for (const r of data.issues) {
    const c = catTotals.get(r.code) ?? { name: r.name, n: 0 };
    c.n += r.n; catTotals.set(r.code, c);
  }
  const complaintsTotal = Array.from(catTotals.values()).reduce((a, b) => a + b.n, 0);
  const topSubs = [...data.issues].sort((a, b) => b.n - a.n).slice(0, 8);

  const volume = data.volume.map((r: any) => ({ ...r, label: bucketLabel(r.bucket, bucket), bucket_end: bucketEnd(r.bucket, bucket) }));
  const sentiment = data.sentiment.map((r: any) => ({ ...r, label: bucketLabel(r.bucket, bucket) }));
  const hours = Array.from({ length: 24 }, (_, h) => {
    const r = data.ops.peakHours.find((x: any) => x.hour === h);
    return { hour: `${String(h).padStart(2, '0')}:00`, n: r?.n ?? 0, missed: r?.missed ?? 0 };
  }).filter((r, i) => (i >= 7 && i <= 22) || r.n > 0);

  return (
    <div className="space-y-5">
      <PageHeader title="Overview" description={<>Support performance for <span className="font-medium text-ink">{range.label}</span>{channel ? ` · ${CHANNEL_LABELS[channel]}` : ''}{k.has_demo && <> · <DemoBadge /></>}</>}
        actions={<>
          <ParamSelect name="channel" placeholder="All channels" options={CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] }))} />
          <ParamSelect name="bucket" placeholder={`By ${bucket}`} options={[{ value: 'day', label: 'By day' }, { value: 'week', label: 'By week' }, { value: 'month', label: 'By month' }]} />
          <RangeFilter />
        </>} />

      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        <KpiCard label="Total interactions" value={fmtNum(k.total)} formula={METRIC_DEFS.total} href={`/inbox${qs({})}`} />
        <KpiCard label="Calls received" value={fmtNum(k.calls_received)} sub={`${fmtNum(k.calls_answered)} answered`} formula={METRIC_DEFS.calls_received + ' ' + METRIC_DEFS.calls_answered} href={`/calls${qs({})}`} />
        <KpiCard label="Missed calls" value={fmtNum(k.missed_calls)} tone={k.missed_calls > 0 ? 'warn' : undefined}
          sub={k.calls_received ? fmtPct(k.missed_calls / k.calls_received) + ' of calls' : undefined} formula={METRIC_DEFS.missed_calls} href={`/calls${qs({ call_status: 'missed' })}`} />
        <KpiCard label="WhatsApp conversations" value={fmtNum(k.whatsapp)} sub={`${fmtNum(k.chats)} web chats`} formula={METRIC_DEFS.whatsapp} href={`/chats${qs({})}`} />
        <KpiCard label="Emails received" value={fmtNum(k.emails)} formula={METRIC_DEFS.emails} href={`/emails${qs({})}`} />
        <KpiCard label="Open critical alerts" value={fmtNum(k.open_critical)} tone={k.open_critical > 0 ? 'bad' : undefined} formula={METRIC_DEFS.open_critical} href="/quality?severity=critical&status=open" />
        <KpiCard label="Avg first response" value={fmtDuration(k.avg_first_response)} sub={k.avg_ring ? `Calls: ${fmtDuration(k.avg_ring)} ring time` : undefined} formula={METRIC_DEFS.avg_first_response} />
        <KpiCard label="Avg resolution time" value={fmtDuration(k.avg_resolution)} formula={METRIC_DEFS.avg_resolution} />
        <KpiCard label="Customer satisfaction" value={k.csat_n ? `${Number(k.csat).toFixed(2)} / 5` : 'No data'} sub={k.csat_n ? `${k.csat_n} responses` : 'No feedback records yet'} formula={METRIC_DEFS.csat} />
        <KpiCard label="First-contact resolution" value={fmtPct(k.fcr)} sub={`${fmtNum(k.resolved_n)} resolved`} formula={METRIC_DEFS.fcr} />
        <KpiCard label="Reopened rate" value={fmtPct(k.reopened_rate)} formula={METRIC_DEFS.reopened} />
        <KpiCard label="AI quality failure rate" value={fmtPct(k.quality_failure)} tone={(k.quality_failure ?? 0) > 0.25 ? 'warn' : undefined} sub={`${fmtNum(k.evaluated_n)} evaluated`} formula={METRIC_DEFS.quality_failure} href={`/inbox${qs({ score_max: String(s.org.settings.reviewThreshold - 0.01) })}`} />
        <KpiCard label="Agent quality score" value={k.quality_score ? fmtNum(k.quality_score, 1) : '—'} sub="out of 100 (AI + reviewed)" formula={METRIC_DEFS.quality_score} href="/agents" />
        <KpiCard label="Pending complaints" value={fmtNum(k.pending_complaints)} formula={METRIC_DEFS.pending_complaints} href={`/inbox${qs({ resolution: 'open,pending,escalated,unresolved', complaints: '1' })}`} />
        <KpiCard label="Refund requests" value={fmtNum(k.refunds)} formula={METRIC_DEFS.refunds} href={`/inbox${qs({ category: 'refund' })}`} />
        <KpiCard label="Replacement requests" value={fmtNum(k.replacements)} formula={METRIC_DEFS.replacements} href={`/inbox${qs({ category: 'replacement' })}`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <ChartCard className="xl:col-span-2" title="Interaction volume" subtitle={`By ${bucket} and channel · click a bar to open those interactions`}
          table={{ columns: ['Period', 'Calls', 'Chat', 'WhatsApp', 'Email'], rows: volume.map((r: any) => [r.label, r.call, r.chat, r.whatsapp, r.email]) }}>
          <StackedBars data={volume} xKey="label"
            series={[{ key: 'call', label: 'Calls', color: SERIES.call }, { key: 'chat', label: 'Chat', color: SERIES.chat },
              { key: 'whatsapp', label: 'WhatsApp', color: SERIES.whatsapp }, { key: 'email', label: 'Email', color: SERIES.email }]}
            hrefTemplate={`/inbox?from={bucket}&to={bucket_end}${channel ? `&channel=${channel}` : ''}`} />
        </ChartCard>
        <ChartCard title="Customer issue distribution" subtitle={`${fmtNum(complaintsTotal)} labels across ${catTotals.size} categories · % of all labels`}
          table={{ columns: ['Category', 'Interactions', 'Share'], rows: Array.from(catTotals.entries()).map(([, v]) => [v.name, v.n, fmtPct(v.n / Math.max(1, complaintsTotal))]) }}>
          <HBarList rows={Array.from(catTotals.entries()).sort((a, b) => b[1].n - a[1].n).map(([code, v]) => ({
            label: v.name, value: v.n, sub: fmtPct(v.n / Math.max(1, complaintsTotal), 0), href: `/inbox${qs({ category: code })}`,
          }))} />
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Agent performance leaderboard" subtitle="Ranked by quality score, not speed or volume — compare within similar channels and case mix" actions={<Link href="/agents" className="text-xs text-brand hover:underline">All agents →</Link>} />
          <Table>
            <THead><tr><th className="th">Agent</th><th className="th">Handled</th><th className="th">Quality</th><th className="th">First response</th><th className="th">Resolution rate</th><th className="th">Open coaching</th></tr></THead>
            <TBody>
              {data.leaders.map((a: any) => (
                <tr key={a.id} className="hover:bg-brand-50/40">
                  <td className="td"><Link href={`/agents/${a.id}`} className="font-medium text-ink hover:text-brand">{a.name}</Link><p className="text-2xs text-ink-muted">{a.team}</p></td>
                  <td className="td tabular-nums">{a.handled}</td>
                  <td className="td"><ScoreBadge score={a.quality} /> <span className="text-2xs text-ink-faint">n={a.evaluated}</span></td>
                  <td className="td tabular-nums">{fmtDuration(a.frt)}</td>
                  <td className="td tabular-nums">{fmtPct(a.resolution_rate, 0)}</td>
                  <td className="td tabular-nums">{a.open_coaching || '—'}</td>
                </tr>
              ))}
              {!data.leaders.length && <tr><td className="td text-ink-muted" colSpan={6}>No agent activity in this range.</td></tr>}
            </TBody>
          </Table>
        </Card>
        <Card>
          <CardHeader title="Quality alerts" subtitle="Most severe and newest first" actions={<Link href="/quality" className="text-xs text-brand hover:underline">Review queue →</Link>} />
          <ul className="divide-y divide-line">
            {data.flags.map((fl: any) => (
              <li key={fl.id}>
                <Link href={`/inbox/${fl.interaction_id}?flag=${fl.id}`} className="block px-4 py-2.5 hover:bg-brand-50/40">
                  <div className="flex items-center gap-2"><SeverityBadge severity={fl.severity} /><FlagStatusBadge status={fl.status} />{fl.is_demo && <DemoBadge />}</div>
                  <p className="mt-1 text-[13px] font-medium text-ink">{fl.title}</p>
                  <p className="text-2xs text-ink-muted">{fl.agent ?? 'Unassigned'} · {fl.ref} · <ChannelBadge channel={fl.channel} /> · {relTime(fl.created_at)}</p>
                </Link>
              </li>
            ))}
            {!data.flags.length && <li className="px-4 py-8 text-center text-sm text-ink-muted">No quality alerts in this range.</li>}
          </ul>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <ChartCard title="Customer sentiment trend" subtitle="Interactions by AI-detected sentiment"
          table={{ columns: ['Period', 'Positive', 'Neutral/mixed', 'Negative'], rows: sentiment.map((r: any) => [r.label, r.positive, r.neutral, r.negative]) }}>
          <Lines data={sentiment} xKey="label" series={[
            { key: 'positive', label: 'Positive', color: SENTIMENT_COLORS.positive },
            { key: 'neutral', label: 'Neutral / mixed', color: SENTIMENT_COLORS.neutral },
            { key: 'negative', label: 'Negative', color: SENTIMENT_COLORS.negative }]} />
        </ChartCard>
        <ChartCard title="Product complaint insights" subtitle="Interactions with quality, replacement or refund labels, by product"
          table={{ columns: ['Product', 'Complaints', 'Quality-related'], rows: data.products.map((p: any) => [p.product, p.n, p.quality_n]) }}>
          <HBarList rows={data.products.map((p: any) => ({ label: p.product, value: p.n, sub: `${p.quality_n} quality`, href: `/inbox${qs({ product: p.product, complaints: '1' })}` }))} />
        </ChartCard>
        <ChartCard title="Top customer issues" subtitle="Subcategories ranked by interactions"
          table={{ columns: ['Issue', 'Category', 'Interactions'], rows: topSubs.map((r: any) => [r.sub_name ?? r.name, r.name, r.n]) }}>
          <HBarList rows={topSubs.map((r: any) => ({ label: r.sub_name ?? r.name, value: r.n, sub: r.name, href: `/inbox${qs({ category: r.code, subcategory: r.sub_code ?? undefined })}` }))} />
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <ChartCard title="Peak call hours" subtitle="Calls by hour of day (IST)" table={{ columns: ['Hour', 'Calls', 'Missed'], rows: hours.map((h) => [h.hour, h.n, h.missed]) }}>
          <ColumnBars data={hours} xKey="hour" yKey="n" label="Calls" />
        </ChartCard>
        <ChartCard title="Missed-call trend" subtitle={`Missed calls by ${bucket}`} table={{ columns: ['Period', 'Missed', 'All calls'], rows: data.ops.missedTrend.map((r: any) => [bucketLabel(r.bucket, bucket), r.missed, r.calls]) }}>
          <ColumnBars data={data.ops.missedTrend.map((r: any) => ({ ...r, label: bucketLabel(r.bucket, bucket), bucket_end: bucketEnd(r.bucket, bucket) }))} xKey="label" yKey="missed" label="Missed calls" color="#c58b00"
            hrefTemplate="/calls?call_status=missed&from={bucket}&to={bucket_end}" />
        </ChartCard>
        <Card>
          <CardHeader title="Resolution bottlenecks" subtitle={<>Repeat-contact rate: <span className="font-medium text-ink">{fmtPct(data.ops.repeat?.rate)}</span> ({fmtNum(data.ops.repeat?.n)} repeat contacts)</>} />
          <Table>
            <THead><tr><th className="th">Primary issue</th><th className="th">Open</th><th className="th">Avg resolution</th></tr></THead>
            <TBody>
              {data.ops.bottlenecks.slice(0, 7).map((b: any) => (
                <tr key={b.code}>
                  <td className="td"><Link className="hover:text-brand" href={`/inbox${qs({ category: b.code, resolution: 'open,pending,escalated,unresolved' })}`}>{b.name}</Link></td>
                  <td className="td whitespace-nowrap tabular-nums">{b.open_n}<span className="text-2xs text-ink-faint"> / {b.total}</span></td>
                  <td className="td tabular-nums">{fmtDuration(b.avg_resolution)}</td>
                </tr>
              ))}
            </TBody>
          </Table>
        </Card>
      </div>
      <p className="text-2xs text-ink-faint">All metrics are computed from stored records for the selected filters. Hover the ⓘ icons for formulas; see docs/METRICS.md for full definitions.</p>
    </div>
  );
}
