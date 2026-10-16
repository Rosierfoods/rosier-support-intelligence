import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { parseChannel, parseRange, sp, withParams, type SP } from '@/lib/filters';
import {
  AGENT_METRIC_DEFS, getAgentFlags, getAgentMetrics, getChannelMix, getConfirmedRules, getCriterionBreakdown, getQualityTrend,
  getRecentReviewed, getScopedAgent, getTeamAggregate, type AgentFilters, type AgentRow,
} from '@/lib/repos/agents';
import { COACHING_STATUS_LABELS, getCoachingSummary, listCoaching, metricLabel, OPEN_COACHING } from '@/lib/repos/coaching';
import { Badge, ButtonLink, Card, CardBody, CardHeader, DemoBadge, KpiCard, Notice, PageHeader, SectionTitle, Table, TBody, THead } from '@/components/ui';
import { ChartCard, HBarList, Lines } from '@/components/charts';
import { ParamSelect, RangeFilter } from '@/components/filters';
import { ChannelBadge, FlagStatusBadge, ReviewBadge, ScoreBadge, SeverityBadge } from '@/components/badges';
import { SampleNote } from '@/components/analytics/SampleNote';
import { bucketLabel, MIN_SAMPLE } from '@/components/analytics/format';
import { SERIES, WARN_COLOR } from '@/lib/palette';
import { CHANNELS, CHANNEL_LABELS } from '@/lib/constants';
import { fmtDate, fmtDuration, fmtNum, fmtPct, relTime, titleCase } from '@/lib/format';

export const metadata = { title: 'Agent detail' };

function vsTeam(v: number | null, t: number | null | undefined, kind: 'score' | 'pct' | 'dur', lowerIsBetter = false) {
  if (v === null || t === null || t === undefined) return undefined;
  const d = v - t;
  const fmt = kind === 'pct' ? `${d > 0 ? '+' : ''}${(d * 100).toFixed(0)} pts` : kind === 'dur' ? `${d > 0 ? '+' : '−'}${fmtDuration(Math.abs(d))}` : `${d > 0 ? '+' : ''}${d.toFixed(1)}`;
  const team = kind === 'pct' ? fmtPct(t, 0) : kind === 'dur' ? fmtDuration(t) : t.toFixed(1);
  const better = lowerIsBetter ? d < 0 : d > 0;
  return <span><span className={Math.abs(d) < 1e-9 ? '' : better ? 'text-emerald-800' : 'text-amber-800'}>{fmt}</span> vs team {team}</span>;
}

export default async function AgentDetailPage(props: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const s = await requireSession();
  const own = s.user.agentId === params.id;
  if (!own && !s.permissions.has('reports.view')) notFound();
  const range = parseRange(searchParams);
  const channel = parseChannel(searchParams);
  const f: AgentFilters = { from: range.from, to: range.to, channel, category: sp(searchParams, 'category') ?? null };
  const bucket = range.days <= 31 ? 'day' : range.days <= 120 ? 'week' : 'month';

  const d = await withOrg(s.org.id, async (db) => {
    const agent = await getScopedAgent(db, s, params.id);
    if (!agent) return null;
    const [m, team, trend, criteria, mix, reviewed, flags, rules, coaching, coachSummary] = await Promise.all([
      getAgentMetrics(db, s, f, agent.id), getTeamAggregate(db, s, f, agent.team_id), getQualityTrend(db, s, f, agent.id, agent.team_id, bucket),
      getCriterionBreakdown(db, s, f, agent.id), getChannelMix(db, s, f, agent.id), getRecentReviewed(db, s, f, agent.id),
      getAgentFlags(db, s, f, agent.id), getConfirmedRules(db, s, f, agent.id),
      listCoaching(db, s, { agentId: agent.id, page: 1, pageSize: 20 }), getCoachingSummary(db, s, { agentId: agent.id }),
    ]);
    return { agent, m, team, trend, criteria, mix, reviewed, flags, rules, coaching, coachSummary };
  });
  if (!d) notFound();
  const { agent, m, team } = d;
  const keep = { range: sp(searchParams, 'range'), from: sp(searchParams, 'from'), to: sp(searchParams, 'to'), channel: channel ?? undefined };
  const inbox = (extra: Record<string, string | undefined>) => `/inbox${withParams(keep as SP, { agent: agent.id, ...extra })}`;
  const gated = (v: number | null, n: number) => (n >= MIN_SAMPLE ? v : null);
  const t: Partial<AgentRow> = team ?? {};

  const enoughCriteria = d.criteria.filter((c) => c.n >= MIN_SAMPLE);
  const weakest = enoughCriteria.length ? enoughCriteria[enoughCriteria.length - 1].code : null;
  const strengths = enoughCriteria.slice(0, 3);
  const weaknesses = [...enoughCriteria].reverse().slice(0, 3).filter((c) => !strengths.some((x) => x.code === c.code));
  const trendRows = d.trend.map((r) => ({ ...r, label: bucketLabel(r.bucket, bucket) }));
  const openPlans = d.coaching.rows.filter((c: any) => OPEN_COACHING.includes(c.status) || c.status === 'completed');
  const hasDemo = m.has_demo || agent.is_demo;

  return (
    <div className="space-y-5">
      <PageHeader title={agent.name}
        description={<>{agent.team ?? 'No team'} · {range.label}{channel ? ` · ${CHANNEL_LABELS[channel]}` : ''}{!agent.is_active && ' · inactive'}{hasDemo && <> · <DemoBadge /></>}</>}
        actions={<>
          <ParamSelect name="channel" placeholder="All channels" options={CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] }))} />
          <RangeFilter />
          {s.permissions.has('reports.view') && !own && <ButtonLink href="/agents" size="sm">All agents</ButtonLink>}
          {s.permissions.has('coaching.assign') && !own && <ButtonLink href={`/coaching/new?agent=${agent.id}`} size="sm" variant="primary">New coaching</ButtonLink>}
        </>}>
        <div className="mt-2"><SampleNote n={m.total} from={range.from} to={range.to} /></div>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        <KpiCard label="Quality score" value={gated(m.quality, m.evaluated) !== null ? fmtNum(m.quality, 1) : 'Insufficient data'} sub={<>n={m.evaluated} · {vsTeam(gated(m.quality, m.evaluated), t.quality, 'score') ?? 'team avg —'}</>} formula={AGENT_METRIC_DEFS.quality} href={inbox({})} />
        <KpiCard label="Policy compliance" value={gated(m.policy, m.policy_n) !== null ? fmtPct(m.policy, 0) : 'Insufficient data'} sub={vsTeam(gated(m.policy, m.policy_n), t.policy, 'pct')} formula={AGENT_METRIC_DEFS.policy} />
        <KpiCard label="First-contact resolution" value={gated(m.fcr, m.resolved) !== null ? fmtPct(m.fcr, 0) : 'Insufficient data'} sub={vsTeam(gated(m.fcr, m.resolved), t.fcr, 'pct')} formula={AGENT_METRIC_DEFS.fcr} href={inbox({ resolution: 'resolved' })} />
        <KpiCard label="Avg first response" value={fmtDuration(m.frt)} sub={vsTeam(m.frt, t.frt, 'dur', true)} formula={AGENT_METRIC_DEFS.frt} />
        <KpiCard label="Avg resolution" value={fmtDuration(m.resolution)} sub={vsTeam(m.resolution, t.resolution, 'dur', true)} formula={AGENT_METRIC_DEFS.resolution} />
        <KpiCard label="Reopened rate" value={fmtPct(m.reopened_rate, 0)} sub={vsTeam(m.reopened_rate, t.reopened_rate, 'pct', true)} formula={AGENT_METRIC_DEFS.reopened} />
        <KpiCard label="Interactions handled" value={fmtNum(m.total)} sub={`${m.calls} calls · ${m.chats} chats · ${m.emails} emails`} formula="Calls, chat/WhatsApp and email threads assigned in range." href={inbox({})} />
        <KpiCard label="Missed / unanswered" value={fmtNum(m.missed)} tone={m.missed ? 'warn' : undefined} formula={AGENT_METRIC_DEFS.missed} />
        <KpiCard label="Customer satisfaction" value={m.csat_n ? `${m.csat!.toFixed(2)} / 5` : 'No data'} sub={m.csat_n ? `${m.csat_n} responses` : 'No feedback records'} formula={AGENT_METRIC_DEFS.csat} />
        <KpiCard label="Confirmed quality issues" value={fmtNum(m.confirmed)} sub={`of ${m.reviewed_flags} reviewed flags`} formula={AGENT_METRIC_DEFS.confirmed} href="#flags" />
        <KpiCard label="AI false-positive rate" value={m.reviewed_flags ? fmtPct(m.fp_rate, 0) : '—'} sub={vsTeam(m.reviewed_flags ? m.fp_rate : null, t.fp_rate, 'pct', true) ?? 'No reviewed flags'} formula={AGENT_METRIC_DEFS.fp_rate} />
        <KpiCard label="Case mix" value={fmtPct(m.complaint_share, 0)} sub={`complaints · ${fmtPct(m.high_share, 0)} high-severity (team ${fmtPct(t.complaint_share, 0)})`} formula={AGENT_METRIC_DEFS.complexity} />
      </div>
      {m.evaluated < MIN_SAMPLE && <Notice tone="info">Fewer than {MIN_SAMPLE} evaluated interactions in this range — scores are hidden to avoid unfair conclusions. Widen the date range for a fuller picture.</Notice>}

      <div className="grid gap-4 xl:grid-cols-3">
        <ChartCard className="xl:col-span-2" title="Quality score trend" subtitle={`Mean quality score per ${bucket}: agent vs team average`}
          table={{ columns: ['Period', 'Agent', 'Team avg', 'Agent n'], rows: trendRows.map((r) => [r.label, r.agent ?? '—', r.team ?? '—', r.n]) }}>
          <Lines data={trendRows} xKey="label" yDomain={[0, 100]} series={[
            { key: 'agent', label: agent.name, color: '#784900' }, { key: 'team', label: 'Team average', color: '#a8a29e' }]} />
        </ChartCard>
        <ChartCard title="Channel mix" subtitle="Interactions by channel · sub = mean quality"
          table={{ columns: ['Channel', 'Interactions', 'Quality'], rows: d.mix.map((r) => [CHANNEL_LABELS[r.channel as keyof typeof CHANNEL_LABELS] ?? r.channel, r.n, r.quality ?? '—']) }}>
          <HBarList rows={d.mix.map((r) => ({
            label: CHANNEL_LABELS[r.channel as keyof typeof CHANNEL_LABELS] ?? r.channel, value: r.n,
            sub: r.quality !== null ? `Q ${Math.round(r.quality)}` : undefined, color: SERIES[r.channel as keyof typeof SERIES], href: inbox({ channel: r.channel }),
          }))} />
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <ChartCard className="xl:col-span-2" title="Criterion breakdown" subtitle={<>Mean score per rubric criterion (0–5), current evaluations, N/A excluded{weakest && <> · weakest highlighted</>}</>}
          table={{ columns: ['Criterion', 'Mean (0–5)', 'n'], rows: d.criteria.map((c) => [c.name, c.avg, c.n]) }}>
          <HBarList max={5} rows={d.criteria.map((c) => ({
            label: c.code === weakest ? `${c.name} — weakest` : c.name, value: c.avg,
            sub: c.n < MIN_SAMPLE ? `n=${c.n} · insufficient` : `/5 · n=${c.n}`, color: c.code === weakest ? WARN_COLOR : undefined,
          }))} />
        </ChartCard>
        <Card>
          <CardHeader title="Strengths & development areas" subtitle={`From criteria with ≥${MIN_SAMPLE} scores and confirmed alerts`} />
          <CardBody className="space-y-4">
            <div>
              <SectionTitle>Strengths</SectionTitle>
              {strengths.length ? <ul className="space-y-1 text-sm">{strengths.map((c) => <li key={c.code} className="flex justify-between gap-2"><span>{c.name}</span><span className="tabular-nums text-emerald-800">{c.avg.toFixed(1)}/5</span></li>)}</ul>
                : <p className="text-sm text-ink-muted">Not enough evaluations yet.</p>}
            </div>
            <div>
              <SectionTitle>Development areas</SectionTitle>
              {weaknesses.length ? <ul className="space-y-1 text-sm">{weaknesses.map((c) => <li key={c.code} className="flex justify-between gap-2"><span>{c.name}</span><span className="tabular-nums text-amber-800">{c.avg.toFixed(1)}/5</span></li>)}</ul>
                : <p className="text-sm text-ink-muted">No clear development areas from the rubric.</p>}
            </div>
            <div>
              <SectionTitle>Confirmed alert types</SectionTitle>
              {d.rules.length ? <ul className="space-y-1 text-sm">{d.rules.map((r) => <li key={r.rule_code} className="flex justify-between gap-2"><span>{r.name ?? titleCase(r.rule_code)}</span><Badge tone="warn">{r.n}×</Badge></li>)}</ul>
                : <p className="text-sm text-ink-muted">No confirmed quality alerts in this range.</p>}
            </div>
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Improvement plan" subtitle={<>Open coaching · {d.coachSummary.completed}/{d.coachSummary.total} completed{d.coachSummary.with_outcome ? ` · ${d.coachSummary.improved} of ${d.coachSummary.with_outcome} reviewed improved` : ''}</>}
            actions={<Link href={`/coaching?agent=${agent.id}`} className="text-xs text-brand hover:underline">All coaching →</Link>} />
          <ul className="divide-y divide-line">
            {openPlans.map((c: any) => (
              <li key={c.id}>
                <Link href={`/coaching/${c.id}`} className="block px-4 py-2.5 hover:bg-brand-50/40">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={c.overdue ? 'bad' : 'brand'}>{COACHING_STATUS_LABELS[c.status]}</Badge>
                    {c.overdue && <Badge tone="bad">Review overdue</Badge>}
                    {c.is_demo && <DemoBadge />}
                  </div>
                  <p className="mt-1 text-[13px] font-medium text-ink">{c.title}</p>
                  <p className="text-2xs text-ink-muted">Target: {metricLabel(c.target_metric)} {c.target_value !== null ? `→ ${Number(c.target_value)}` : ''}{c.baseline_value !== null ? ` (baseline ${Number(c.baseline_value)})` : ''} · review {fmtDate(c.review_date)}</p>
                </Link>
              </li>
            ))}
            {!openPlans.length && <li className="px-4 py-8 text-center text-sm text-ink-muted">No open coaching. {d.coaching.total > 0 && 'Past plans are listed on the coaching page.'}</li>}
          </ul>
        </Card>
        <Card id="flags">
          <CardHeader title="Flagged interactions" subtitle="AI alerts on this agent’s conversations · opens the evidence" />
          <ul className="divide-y divide-line">
            {d.flags.map((fl: any) => (
              <li key={fl.id}>
                <Link href={`/inbox/${fl.interaction_id}?flag=${fl.id}`} className="block px-4 py-2.5 hover:bg-brand-50/40">
                  <div className="flex flex-wrap items-center gap-2"><SeverityBadge severity={fl.severity} /><FlagStatusBadge status={fl.status} />{fl.is_demo && <DemoBadge />}</div>
                  <p className="mt-1 text-[13px] font-medium text-ink">{fl.title}</p>
                  <p className="text-2xs text-ink-muted">{fl.ref} · <ChannelBadge channel={fl.channel} /> · {relTime(fl.created_at)}</p>
                </Link>
              </li>
            ))}
            {!d.flags.length && <li className="px-4 py-8 text-center text-sm text-ink-muted">No quality alerts in this range.</li>}
          </ul>
        </Card>
      </div>

      <Card>
        <CardHeader title="Recently reviewed interactions" subtitle="Human-reviewed first, then the latest AI-evaluated" />
        <Table>
          <THead><tr><th className="th">Interaction</th><th className="th">Channel</th><th className="th">Issue</th><th className="th">Score</th><th className="th">Review</th><th className="th">Date</th></tr></THead>
          <TBody>
            {d.reviewed.map((r: any) => (
              <tr key={r.id} className="hover:bg-brand-50/40">
                <td className="td"><Link className="font-medium text-ink hover:text-brand" href={`/inbox/${r.id}`}>{r.ref}</Link>{r.is_demo && <DemoBadge className="ml-1.5" />}<p className="max-w-xs truncate text-2xs text-ink-muted">{r.subject}</p></td>
                <td className="td"><ChannelBadge channel={r.channel} /></td>
                <td className="td text-xs">{r.issue ?? '—'}</td>
                <td className="td"><ScoreBadge score={r.quality_score} band={r.quality_band} /></td>
                <td className="td"><ReviewBadge status={r.review_status} /></td>
                <td className="td whitespace-nowrap text-xs text-ink-muted">{fmtDate(r.occurred_at)}</td>
              </tr>
            ))}
            {!d.reviewed.length && <tr><td className="td text-ink-muted" colSpan={6}>No evaluated interactions in this range.</td></tr>}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}
