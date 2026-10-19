import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Download, ShieldAlert } from 'lucide-react';
import { requireSession } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { withParams, type SP } from '@/lib/filters';
import { getFilterOptions } from '@/lib/repos/analytics';
import { getAgentReview, getCriticalAlerts, parseActivityFilters } from '@/lib/repos/activity';
import { Badge, Card, CardHeader, EmptyState, KpiCard, Notice, PageHeader, Table, TBody, THead, buttonClass } from '@/components/ui';
import { ClearFilters, ParamSelect, RangeFilter } from '@/components/filters';
import { AgentTabs } from '@/components/analytics/AgentTabs';
import { fmtDateTime, fmtPct, titleCase } from '@/lib/format';

export const metadata = { title: 'Agent review & accuracy' };

const MIN_N = 3;

function Score({ v, n }: { v: number | null; n: number }) {
  if (v === null || n < MIN_N) return <span className="text-2xs text-ink-faint">{n ? `n=${n}, too few` : 'not scored yet'}</span>;
  const tone = v >= 85 ? 'text-emerald-700' : v >= 70 ? 'text-ink' : v >= 60 ? 'text-amber-700' : 'text-red-700';
  return <span className={`font-semibold tabular-nums ${tone}`}>{v.toFixed(0)}<span className="text-2xs font-normal text-ink-faint"> n={n}</span></span>;
}

function Acc({ v, n }: { v: number | null; n: number }) {
  if (v === null || n < MIN_N) return <span className="text-2xs text-ink-faint">—</span>;
  const tone = v >= 0.95 ? 'text-emerald-700' : v >= 0.85 ? 'text-ink' : 'text-red-700';
  return <span className={`font-semibold tabular-nums ${tone}`}>{fmtPct(v, 0)}</span>;
}

export default async function AgentReviewPage(props: { searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const s = await requireSession();
  if (!s.permissions.has('reports.view')) redirect('/forbidden');
  const f = parseActivityFilters(searchParams, '30d');
  const { rows, alerts, opts } = await withOrg(s.org.id, async (db) => {
    const [rows, alerts, opts] = await Promise.all([getAgentReview(db, s, f), getCriticalAlerts(db, s, f), getFilterOptions(db, s)]);
    return { rows, alerts, opts };
  });
  const tot = rows.reduce((a, r) => ({
    evaluated: a.evaluated + r.evaluated, qsum: a.qsum + (r.quality ?? 0) * r.evaluated, wrong: a.wrong + r.incorrect_statements,
    viol: a.viol + r.policy_violations, crit: a.crit + r.critical_alerts, open: a.open + r.open_alerts,
  }), { evaluated: 0, qsum: 0, wrong: 0, viol: 0, crit: 0, open: 0 });
  const avgQ = tot.evaluated ? tot.qsum / tot.evaluated : null;
  const canExport = s.permissions.has('reports.export');
  const keep = { range: searchParams.range, from: searchParams.from, to: searchParams.to } as SP;

  return (
    <div className="space-y-5">
      <PageHeader title="Agent review & accuracy"
        description={<>Call quality, accuracy of information given, policy compliance, critical alerts and ticket outcomes per agent · <span className="font-medium text-ink">{f.rangeLabel}</span></>}
        actions={<>
          {opts.teams.length > 1 && <ParamSelect name="team" placeholder="All teams" options={opts.teams.map((t) => ({ value: t.id, label: t.name }))} />}
          {opts.agents.length > 0 && <ParamSelect name="agent" placeholder="All agents" options={opts.agents.map((a) => ({ value: a.id, label: a.name }))} />}
          <RangeFilter />
          <ClearFilters />
          {canExport && <a href={`/api/export/agent-review${withParams(searchParams, {})}`} className={buttonClass('secondary', 'md')}><Download size={14} /> Download Excel</a>}
        </>} />
      <AgentTabs current="/agents/review" searchParams={searchParams} />

      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Average quality" value={avgQ === null ? '—' : avgQ.toFixed(0)} sub={`${tot.evaluated} scored conversations`} />
        <KpiCard label="Wrong information given" value={String(tot.wrong)} tone={tot.wrong ? 'bad' : undefined} sub="incorrect statements found" />
        <KpiCard label="Policy violations" value={String(tot.viol)} tone={tot.viol ? 'warn' : undefined} />
        <KpiCard label="Critical alerts" value={String(tot.crit)} tone={tot.crit ? 'bad' : undefined} href="/quality?severity=critical" />
        <KpiCard label="Alerts waiting review" value={String(tot.open)} tone={tot.open ? 'warn' : undefined} href="/quality?status=open" />
        <KpiCard label="Agents" value={String(rows.filter((r) => r.agent_id).length)} />
      </div>

      <Notice tone="info" title="How these are calculated">
        <b>Quality</b> = average AI/human score (0–100) of scored conversations. <b>Call quality</b> = the same for calls only.
        <b> Accuracy</b> = share of scored conversations where the agent gave no wrong information. Scores with fewer than {MIN_N} conversations are hidden.
        Alerts are potential concerns for a reviewer to confirm — not automatic findings against the agent.
      </Notice>

      <Card>
        <CardHeader title="Agent review" />
        {rows.length === 0 ? <EmptyState title="No scored conversations in this period" description="Scores appear after calls are transcribed and analysed." /> : (
          <Table>
            <THead><tr>
              <th className="th">Agent</th><th className="th">Conversations</th><th className="th">Quality</th><th className="th">Call quality</th>
              <th className="th">Accuracy</th><th className="th">Wrong info</th><th className="th">Policy violations</th>
              <th className="th">Critical</th><th className="th">High</th><th className="th">Confirmed</th><th className="th">Waiting review</th>
              <th className="th">Tickets resolved</th><th className="th">Refunds</th><th className="th">Replacements</th><th className="th">Escalated</th>
              <th className="th">Negative customers</th>
            </tr></THead>
            <TBody>
              {rows.map((r) => (
                <tr key={r.agent_id ?? 'none'} className="hover:bg-brand-50/40">
                  <td className="td min-w-[9rem]">
                    {r.agent_id ? <Link href={`/agents/${r.agent_id}${withParams(keep, {})}`} className="font-medium hover:text-brand">{r.agent_name}</Link> : <span className="text-ink-muted">Unassigned</span>}
                    <p className="text-2xs text-ink-muted">{r.team ?? ''}</p>
                  </td>
                  <td className="td tabular-nums">{r.interactions}<p className="text-2xs text-ink-faint">{r.calls} calls</p></td>
                  <td className="td"><Score v={r.quality} n={r.evaluated} /></td>
                  <td className="td"><Score v={r.call_quality} n={r.call_evaluated} /></td>
                  <td className="td"><Acc v={r.accuracy} n={r.evaluated} /></td>
                  <td className="td tabular-nums">{r.incorrect_statements ? <span className="text-red-700">{r.incorrect_statements}</span> : '0'}</td>
                  <td className="td tabular-nums">{r.policy_violations ? <span className="text-amber-800">{r.policy_violations}</span> : '0'}</td>
                  <td className="td tabular-nums">{r.critical_alerts ? <Badge tone="bad">{r.critical_alerts}</Badge> : '0'}</td>
                  <td className="td tabular-nums">{r.high_alerts ? <Badge tone="warn">{r.high_alerts}</Badge> : '0'}</td>
                  <td className="td tabular-nums">{r.confirmed_alerts}</td>
                  <td className="td tabular-nums">{r.open_alerts ? <Link href={`/quality?status=open${r.agent_id ? `&agent=${r.agent_id}` : ''}`} className="text-amber-800 hover:underline">{r.open_alerts}</Link> : '0'}</td>
                  <td className="td whitespace-nowrap tabular-nums">{r.tickets ? <>{r.resolved_tickets}/{r.tickets} <span className="text-2xs text-ink-faint">({fmtPct(r.resolved_tickets / r.tickets, 0)})</span></> : '—'}</td>
                  <td className="td tabular-nums"><Link href={`/tickets?action=refund${r.agent_id ? `&agent=${r.agent_id}` : ''}`} className="hover:text-brand">{r.refunds}</Link></td>
                  <td className="td tabular-nums"><Link href={`/tickets?action=replacement${r.agent_id ? `&agent=${r.agent_id}` : ''}`} className="hover:text-brand">{r.replacements}</Link></td>
                  <td className="td tabular-nums">{r.escalations}</td>
                  <td className="td tabular-nums">{r.negative_sentiment}</td>
                </tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card id="critical">
        <CardHeader title={<span className="inline-flex items-center gap-1.5"><ShieldAlert size={15} className="text-red-700" /> Critical alerts</span>}
          subtitle="Newest first; unreviewed on top. Managers and admins also get an in-app notification (and email, if enabled in Settings) the moment one is raised." />
        {alerts.length === 0 ? <p className="px-4 pb-4 text-sm text-ink-muted">No critical alerts in this period.</p> : (
          <Table>
            <THead><tr><th className="th">When</th><th className="th">Order / ID</th><th className="th">Agent</th><th className="th">Alert</th><th className="th">Status</th></tr></THead>
            <TBody>
              {alerts.map((a) => (
                <tr key={a.id} className="hover:bg-brand-50/40">
                  <td className="td whitespace-nowrap text-xs">{fmtDateTime(a.created_at)}</td>
                  <td className="td"><Link href={`/inbox/${a.interaction_id}?flag=${a.id}#evidence`} className="font-medium hover:text-brand">{a.order_ref ?? a.ref}</Link>{a.order_ref && <p className="text-2xs text-ink-faint">{a.ref}</p>}</td>
                  <td className="td">{a.agent_name ?? <span className="text-ink-faint">Unassigned</span>}</td>
                  <td className="td text-sm">{a.title}</td>
                  <td className="td"><Badge tone={a.status === 'new' || a.status === 'under_review' ? 'bad' : 'muted'}>{titleCase(a.status.replace(/_/g, ' '))}</Badge></td>
                </tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
