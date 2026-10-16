import Link from 'next/link';
import { requireSession } from '@/lib/auth/session';
import { withOrg, isUuid } from '@/lib/db';
import { parsePage, sp, type SP } from '@/lib/filters';
import {
  COACHING_METRIC_DEFS, COACHING_STATUS_LABELS, coachingAgentOptions, getCoachingSummary, listCoaching, metricLabel,
} from '@/lib/repos/coaching';
import { Badge, ButtonLink, Card, DemoBadge, EmptyState, KpiCard, Notice, PageHeader, Table, TBody, THead } from '@/components/ui';
import { ClearFilters, ParamSelect } from '@/components/filters';
import { Pagination } from '@/components/pagination';
import { SeverityBadge } from '@/components/badges';
import { fmtDate, fmtNum, fmtPct } from '@/lib/format';
import { GraduationCap } from 'lucide-react';
import { CoachingProgress, coachingTone } from '@/components/analytics/coachingUi';

export const metadata = { title: 'Coaching & Improvement' };

export default async function CoachingPage(props: { searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const s = await requireSession();
  const canAssign = s.permissions.has('coaching.assign');
  const seeAll = canAssign || s.permissions.has('coaching.view_all');
  const { page, pageSize } = parsePage(searchParams, 25);
  const agentParam = sp(searchParams, 'agent');
  const filters = {
    status: sp(searchParams, 'status') ?? null, source: sp(searchParams, 'source') ?? null,
    agentId: agentParam && isUuid(agentParam) ? agentParam : null, overdue: sp(searchParams, 'overdue') === '1', page, pageSize,
  };
  const d = await withOrg(s.org.id, async (db) => {
    const [list, summary, agents] = await Promise.all([
      listCoaching(db, s, filters), getCoachingSummary(db, s, { agentId: filters.agentId }), seeAll ? coachingAgentOptions(db, s) : Promise.resolve([]),
    ]);
    return { list, summary, agents };
  });
  const sm = d.summary;
  const noAgentLink = !seeAll && !s.user.agentId;

  return (
    <div className="space-y-5">
      <PageHeader title={seeAll ? 'Coaching & Improvement' : 'My Coaching'}
        description={seeAll ? 'Evidence-based coaching from verified quality issues, and whether it worked.' : 'Feedback and improvement plans assigned to you.'}
        actions={<>
          {seeAll && d.agents.length > 1 && <ParamSelect name="agent" placeholder="All agents" options={d.agents.map((a) => ({ value: a.id, label: a.name }))} />}
          <ParamSelect name="status" placeholder="All statuses" options={[{ value: 'open', label: 'Open (not completed)' }, ...['assigned', 'acknowledged', 'in_progress', 'completed', 'reviewed', 'cancelled'].map((v) => ({ value: v, label: COACHING_STATUS_LABELS[v] }))]} />
          {seeAll && <ParamSelect name="source" placeholder="All sources" options={[{ value: 'ai', label: 'From AI alert' }, { value: 'manual', label: 'Manual' }]} />}
          <ParamSelect name="overdue" placeholder="Any review date" options={[{ value: '1', label: 'Review overdue' }]} />
          <ClearFilters />
          {canAssign && <ButtonLink href="/coaching/new" variant="primary" size="sm">New coaching</ButtonLink>}
        </>} />

      {noAgentLink && <Notice tone="info" title="Your account isn’t linked to an agent profile">Coaching assigned to you will appear here once an administrator links your account to your agent profile.</Notice>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiCard label="Coaching plans" value={fmtNum(sm.total)} sub={`${fmtNum(sm.open)} open`} formula="Non-draft, non-cancelled coaching actions in your scope." />
        <KpiCard label="Completion rate" value={fmtPct(sm.total ? sm.completed / sm.total : null, 0)} sub={`${sm.completed} completed or reviewed`} formula={COACHING_METRIC_DEFS.completion} />
        <KpiCard label="Improved after review" value={sm.with_outcome ? fmtPct(sm.improved / sm.with_outcome, 0) : '—'} sub={sm.with_outcome ? `${sm.improved} of ${sm.with_outcome} reviewed` : 'No reviewed plans yet'} formula={COACHING_METRIC_DEFS.improved} />
        <KpiCard label="Avg measured change" value={sm.delta_n ? `${Number(sm.avg_delta) > 0 ? '+' : ''}${Number(sm.avg_delta).toFixed(1)}` : '—'} sub={sm.delta_n ? `points vs baseline · n=${sm.delta_n}` : 'Needs reviewed plans with a baseline'} formula={COACHING_METRIC_DEFS.delta} tone={sm.delta_n && Number(sm.avg_delta) < 0 ? 'warn' : undefined} />
        <KpiCard label="Reviews overdue" value={fmtNum(sm.overdue)} tone={sm.overdue ? 'bad' : undefined} formula={COACHING_METRIC_DEFS.overdue} href="/coaching?overdue=1" />
      </div>

      <Card>
        {d.list.rows.length ? (
          <>
            <Table>
              <THead><tr>
                <th className="th">Coaching</th>{seeAll && <th className="th">Agent</th>}<th className="th">Status</th><th className="th">Progress</th>
                <th className="th">Target</th><th className="th">Review date</th><th className="th">Source</th>
              </tr></THead>
              <TBody>
                {d.list.rows.map((c: any) => (
                  <tr key={c.id} className={c.overdue ? 'bg-red-50/40 hover:bg-red-50/70' : 'hover:bg-brand-50/40'}>
                    <td className="td max-w-sm">
                      <Link href={`/coaching/${c.id}`} className="font-medium text-ink hover:text-brand">{c.title}</Link>
                      <p className="text-2xs text-ink-muted">Assigned {fmtDate(c.assigned_at ?? c.created_at)} {c.is_demo && <DemoBadge className="ml-1" />}</p>
                    </td>
                    {seeAll && <td className="td"><Link href={`/agents/${c.agent_id}`} className="hover:text-brand">{c.agent}</Link><p className="text-2xs text-ink-muted">{c.team ?? ''}</p></td>}
                    <td className="td"><Badge tone={coachingTone(c.status)}>{COACHING_STATUS_LABELS[c.status]}</Badge>
                      {c.outcome && <p className="mt-1 text-2xs text-ink-muted">Outcome: {c.outcome.replace('_', ' ')}</p>}</td>
                    <td className="td"><CoachingProgress status={c.status} /></td>
                    <td className="td text-xs">{metricLabel(c.target_metric)}{c.target_value !== null && <span className="text-ink-muted"> → {Number(c.target_value)}</span>}
                      {c.baseline_value !== null && <p className="text-2xs text-ink-faint">baseline {Number(c.baseline_value)}{c.outcome_value !== null ? ` · measured ${Number(c.outcome_value)}` : ''}</p>}</td>
                    <td className="td whitespace-nowrap text-xs">{c.overdue ? <span className="font-medium text-red-800">{fmtDate(c.review_date)} · overdue</span> : fmtDate(c.review_date)}</td>
                    <td className="td whitespace-nowrap text-xs">{c.flag_id ? <span className="inline-flex items-center gap-1.5">AI alert {c.flag_severity && <SeverityBadge severity={c.flag_severity} />}</span> : 'Manual'}</td>
                  </tr>
                ))}
              </TBody>
            </Table>
            <Pagination searchParams={searchParams} page={page} pageSize={pageSize} total={d.list.total} basePath="/coaching" />
          </>
        ) : (
          <EmptyState icon={<GraduationCap size={28} />} title="No coaching plans match these filters"
            description={canAssign ? 'Coaching is created from a verified quality alert (in the review queue) or manually.' : 'When your manager assigns coaching, it will appear here.'}
            action={canAssign ? <div className="flex gap-2"><ButtonLink href="/quality?status=confirmed" size="sm">Confirmed alerts</ButtonLink><ButtonLink href="/coaching/new" variant="primary" size="sm">New manual coaching</ButtonLink></div> : undefined} />
        )}
      </Card>
    </div>
  );
}
