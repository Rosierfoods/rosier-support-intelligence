import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { withOrg, isUuid } from '@/lib/db';
import { parseChannel, parseRange, sp, spAll, withParams, type SP } from '@/lib/filters';
import { getFilterOptions } from '@/lib/repos/analytics';
import { AGENT_METRIC_DEFS, getAgentTable, type AgentFilters, type AgentRow } from '@/lib/repos/agents';
import { Card, CardHeader, DemoBadge, Notice, PageHeader, Table, TBody, THead, buttonClass } from '@/components/ui';
import { ClearFilters, ParamSelect, RangeFilter } from '@/components/filters';
import { SortLink } from '@/components/pagination';
import { GatedScore, DeltaBadge } from '@/components/analytics/agentFormat';
import { SampleNote } from '@/components/analytics/SampleNote';
import { MIN_SAMPLE } from '@/components/analytics/format';
import { SERIES } from '@/lib/palette';
import { CHANNELS, CHANNEL_LABELS } from '@/lib/constants';
import { fmtDuration, fmtNum, fmtPct } from '@/lib/format';

export const metadata = { title: 'Agent Performance' };

const SORTS: Record<string, (r: AgentRow) => number | string | null> = {
  name: (r) => r.name ?? '',
  total: (r) => r.total,
  quality: (r) => (r.evaluated >= MIN_SAMPLE ? r.quality : null),
  fcr: (r) => (r.resolved >= MIN_SAMPLE ? r.fcr : null),
  policy: (r) => (r.policy_n >= MIN_SAMPLE ? r.policy : null),
  confirmed: (r) => r.confirmed,
  complexity: (r) => r.complaint_share,
};

function Th({ label, def, sort, searchParams }: { label: string; def?: string; sort?: string; searchParams: SP }) {
  return (
    <th className="th" title={def}>
      {sort ? <SortLink searchParams={searchParams} basePath="/agents" field={sort} label={label} /> : label}
      {def && <span className="ml-0.5 cursor-help text-ink-faint" aria-hidden>ⓘ</span>}
    </th>
  );
}

function MixBar({ r }: { r: AgentRow }) {
  const t = Math.max(1, r.total);
  const parts = [['call', r.calls], ['chat', r.chats], ['email', r.emails]] as const;
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-sand/50" aria-label={`Calls ${r.calls}, chats ${r.chats}, emails ${r.emails}`}>
      {parts.map(([k, v]) => v > 0 && <span key={k} style={{ width: `${(v / t) * 100}%`, background: k === 'chat' ? SERIES.whatsapp : SERIES[k] }} />)}
    </div>
  );
}

export default async function AgentsPage(props: { searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const s = await requireSession();
  if (s.user.role === 'support_agent' || !s.permissions.has('reports.view')) {
    if (s.user.agentId || s.user.role === 'support_agent') redirect('/agents/me');
    redirect('/forbidden');
  }
  const range = parseRange(searchParams);
  const channel = parseChannel(searchParams);
  const team = sp(searchParams, 'team');
  const f: AgentFilters = {
    from: range.from, to: range.to, channel, category: sp(searchParams, 'category') ?? null,
    teamFilter: team && isUuid(team) ? team : null,
  };
  const compareIds = spAll(searchParams, 'compare').filter(isUuid);

  const { rows, opts } = await withOrg(s.org.id, async (db) => {
    const [rows, opts] = await Promise.all([getAgentTable(db, s, f), getFilterOptions(db, s)]);
    return { rows, opts };
  });

  const [sortField, sortDir] = (sp(searchParams, 'sort') ?? 'name:asc').split(':');
  const getter = SORTS[sortField] ?? SORTS.name;
  const visible = channel || f.category ? rows.filter((r) => r.total > 0 || compareIds.includes(r.agent_id!)) : rows;
  const sorted = [...visible].sort((a, b) => {
    const va = getter(a), vb = getter(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    const c = typeof va === 'string' ? va.localeCompare(String(vb)) : (va as number) - (vb as number);
    return sortDir === 'desc' ? -c : c;
  });
  const compared = compareIds.map((id) => rows.find((r) => r.agent_id === id)).filter(Boolean) as AgentRow[];
  const hasDemo = rows.some((r) => r.has_demo);
  const totalN = rows.reduce((a, r) => a + r.total, 0);
  const keep = { range: sp(searchParams, 'range'), from: sp(searchParams, 'from'), to: sp(searchParams, 'to'), channel: channel ?? undefined, category: f.category ?? undefined, team: f.teamFilter ?? undefined };
  const inboxQ = (extra: Record<string, string | undefined>) => `/inbox${withParams({ range: keep.range, from: keep.from, to: keep.to, channel: keep.channel, category: keep.category } as SP, extra)}`;

  return (
    <div className="space-y-5">
      <PageHeader title="Agent Performance"
        description={<>Outcomes and quality per agent for <span className="font-medium text-ink">{range.label}</span>{channel ? ` · ${CHANNEL_LABELS[channel]}` : ''}{hasDemo && <> · <DemoBadge /></>}</>}
        actions={<>
          {opts.teams.length > 1 && <ParamSelect name="team" placeholder="All teams" options={opts.teams.map((t) => ({ value: t.id, label: t.name }))} />}
          <ParamSelect name="channel" placeholder="All channels" options={CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] }))} />
          <ParamSelect name="category" placeholder="All case types" options={opts.categories.map((c) => ({ value: c.code, label: c.name }))} />
          <RangeFilter />
          <ClearFilters />
        </>} />

      <Notice tone="info" title="How to read this page fairly">
        Agents are not ranked by speed or volume. Compare people on the same channel and case type (use the filters), and read quality alongside case mix:
        agents who take more complaints and high-severity cases face harder conversations. Scores based on fewer than {MIN_SAMPLE} interactions are hidden as
        “insufficient data”, and sample sizes (n) are shown next to every score. False-positive rates describe the AI’s accuracy, not the agent.
      </Notice>

      {compareIds.length > 0 && (compared.length < 2 || compared.length > 4 ? (
        <Notice tone="warn" title="Select 2 to 4 agents to compare">You selected {compared.length}. Tick between two and four agents in the table and press “Compare selected”.</Notice>
      ) : (
        <Card>
          <CardHeader title={`Side-by-side comparison (${compared.length} agents)`}
            subtitle={<>Same filters for everyone{channel ? ` · ${CHANNEL_LABELS[channel]} only` : ' · all channels — consider filtering to one channel'}{f.category ? ' · one case type' : ''}. Check the case mix row before drawing conclusions.</>}
            actions={<Link href={`/agents${withParams(searchParams, { compare: undefined })}`} className="text-xs text-brand hover:underline">Clear comparison</Link>} />
          <div className={`grid gap-px bg-line sm:grid-cols-2 ${compared.length > 2 ? 'xl:grid-cols-4' : ''}`}>
            {compared.map((r) => (
              <div key={r.agent_id} className="bg-white p-4">
                <Link href={`/agents/${r.agent_id}${withParams(keep as SP, {})}`} className="text-sm font-semibold text-ink hover:text-brand">{r.name}</Link>
                <p className="text-2xs text-ink-muted">{r.team ?? 'No team'} · n = {r.total} interactions</p>
                <div className="mt-2"><MixBar r={r} /></div>
                <p className="mt-1 text-2xs text-ink-faint">{r.calls} calls · {r.chats} chats · {r.emails} emails</p>
                <dl className="mt-3 space-y-1.5 text-xs">
                  {([
                    ['Quality', <GatedScore key="q" value={r.quality} n={r.evaluated} />],
                    ['Policy compliance', <GatedScore key="p" value={r.policy} n={r.policy_n} kind="pct" />],
                    ['First-contact resolution', <GatedScore key="f" value={r.fcr} n={r.resolved} kind="pct" />],
                    ['Reopened rate', fmtPct(r.reopened_rate, 0)],
                    ['Avg first response', fmtDuration(r.frt)],
                    ['Avg resolution', fmtDuration(r.resolution)],
                    ['Confirmed issues', fmtNum(r.confirmed)],
                    ['Complaint share', fmtPct(r.complaint_share, 0)],
                    ['High-severity share', fmtPct(r.high_share, 0)],
                    ['Change vs prev. period', <DeltaBadge key="d" cur={r.quality} prev={r.prev_quality} nCur={r.evaluated} nPrev={r.prev_evaluated} />],
                  ] as [string, React.ReactNode][]).map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between gap-2 border-b border-line/60 pb-1 last:border-0"><dt className="text-ink-muted">{k}</dt><dd className="text-right text-ink">{v}</dd></div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </Card>
      ))}

      <Card>
        <CardHeader title="All agents" subtitle={<SampleNote n={totalN} from={range.from} to={range.to} />}
          actions={<button type="submit" form="compare-form" className={buttonClass('secondary', 'sm')}>Compare selected</button>} />
        <form id="compare-form" action="/agents" method="get" className="hidden">
          {Object.entries(keep).map(([k, v]) => v ? <input key={k} type="hidden" name={k} value={v} /> : null)}
        </form>
        <Table>
          <THead>
            <tr>
              <th className="th"><span className="sr-only">Compare</span></th>
              <Th label="Agent" sort="name" searchParams={searchParams} />
              <Th label="Handled" def="Calls · chats/WhatsApp · emails assigned in range" sort="total" searchParams={searchParams} />
              <Th label="Missed / unanswered" def={AGENT_METRIC_DEFS.missed} searchParams={searchParams} />
              <Th label="First response" def={AGENT_METRIC_DEFS.frt} searchParams={searchParams} />
              <Th label="Resolution" def={AGENT_METRIC_DEFS.resolution} searchParams={searchParams} />
              <Th label="Quality" def={AGENT_METRIC_DEFS.quality} sort="quality" searchParams={searchParams} />
              <Th label="Δ vs prev." def={AGENT_METRIC_DEFS.improvement} searchParams={searchParams} />
              <Th label="FCR" def={AGENT_METRIC_DEFS.fcr} sort="fcr" searchParams={searchParams} />
              <Th label="Reopened" def={AGENT_METRIC_DEFS.reopened} searchParams={searchParams} />
              <Th label="CSAT" def={AGENT_METRIC_DEFS.csat} searchParams={searchParams} />
              <Th label="Policy" def={AGENT_METRIC_DEFS.policy} sort="policy" searchParams={searchParams} />
              <Th label="Confirmed issues" def={AGENT_METRIC_DEFS.confirmed} sort="confirmed" searchParams={searchParams} />
              <Th label="AI false-pos." def={AGENT_METRIC_DEFS.fp_rate} searchParams={searchParams} />
              <Th label="Coaching" def={AGENT_METRIC_DEFS.coaching} searchParams={searchParams} />
              <Th label="Case mix" def={AGENT_METRIC_DEFS.complexity} sort="complexity" searchParams={searchParams} />
            </tr>
          </THead>
          <TBody>
            {sorted.map((r) => (
              <tr key={r.agent_id} className="hover:bg-brand-50/40">
                <td className="td">
                  <input type="checkbox" name="compare" value={r.agent_id!} form="compare-form" defaultChecked={compareIds.includes(r.agent_id!)}
                    className="h-4 w-4 accent-[#784900]" aria-label={`Compare ${r.name}`} />
                </td>
                <td className="td min-w-[10rem]">
                  <Link href={`/agents/${r.agent_id}${withParams(keep as SP, {})}`} className="font-medium text-ink hover:text-brand">{r.name}</Link>
                  <p className="text-2xs text-ink-muted">{r.team ?? 'No team'}{!r.is_active && ' · inactive'}</p>
                </td>
                <td className="td min-w-[8rem]">
                  <Link href={inboxQ({ agent: r.agent_id! })} className="tabular-nums hover:text-brand">{r.total}</Link>
                  <div className="mt-1"><MixBar r={r} /></div>
                  <p className="mt-0.5 whitespace-nowrap text-2xs text-ink-faint">{r.calls} · {r.chats} · {r.emails}</p>
                </td>
                <td className="td tabular-nums">{r.missed ? <span className="text-amber-800">{r.missed}</span> : '0'}</td>
                <td className="td whitespace-nowrap tabular-nums">{fmtDuration(r.frt)}</td>
                <td className="td whitespace-nowrap tabular-nums">{fmtDuration(r.resolution)}</td>
                <td className="td"><GatedScore value={r.quality} n={r.evaluated} /></td>
                <td className="td"><DeltaBadge cur={r.quality} prev={r.prev_quality} nCur={r.evaluated} nPrev={r.prev_evaluated} /></td>
                <td className="td"><GatedScore value={r.fcr} n={r.resolved} kind="pct" /></td>
                <td className="td tabular-nums">{fmtPct(r.reopened_rate, 0)}</td>
                <td className="td whitespace-nowrap tabular-nums">{r.csat_n ? <>{r.csat!.toFixed(1)}<span className="text-2xs text-ink-faint"> n={r.csat_n}</span></> : <span className="text-2xs text-ink-faint">no feedback</span>}</td>
                <td className="td"><GatedScore value={r.policy} n={r.policy_n} kind="pct" /></td>
                <td className="td tabular-nums">{r.confirmed ? <Link className="hover:text-brand" href={`/agents/${r.agent_id}#flags`}>{r.confirmed}</Link> : '0'}</td>
                <td className="td whitespace-nowrap tabular-nums">{r.reviewed_flags ? <>{fmtPct(r.fp_rate, 0)}<span className="text-2xs text-ink-faint"> of {r.reviewed_flags}</span></> : '—'}</td>
                <td className="td tabular-nums">{r.coaching ? <Link className="hover:text-brand" href={`/coaching?agent=${r.agent_id}`}>{r.coaching}</Link> : '0'}</td>
                <td className="td whitespace-nowrap text-xs">
                  <span title="Share of interactions with a complaint label">{fmtPct(r.complaint_share, 0)} complaints</span>
                  <p className="text-2xs text-ink-faint">{fmtPct(r.high_share, 0)} high-sev · {r.labels_per !== null ? r.labels_per.toFixed(1) : '—'} labels/case</p>
                </td>
              </tr>
            ))}
            {!sorted.length && <tr><td className="td text-ink-muted" colSpan={16}>No agents in your scope for these filters.</td></tr>}
            {visible.length < rows.length && <tr><td className="td text-2xs text-ink-faint" colSpan={16}>{rows.length - visible.length} agent(s) with no interactions for this channel / case type are hidden.</td></tr>}
          </TBody>
        </Table>
      </Card>
      <p className="text-2xs text-ink-faint">Hover column headers (ⓘ) for formulas. Missed/unanswered counts use assignment data where providers supply it.</p>
    </div>
  );
}
