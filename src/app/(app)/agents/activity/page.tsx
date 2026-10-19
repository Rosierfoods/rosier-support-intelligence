import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Download } from 'lucide-react';
import { requireSession } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { withParams, type SP } from '@/lib/filters';
import { getFilterOptions } from '@/lib/repos/analytics';
import { getDailyActivity, parseActivityFilters, totalsByAgent } from '@/lib/repos/activity';
import { Card, CardHeader, EmptyState, KpiCard, PageHeader, Table, TBody, THead, buttonClass } from '@/components/ui';
import { ClearFilters, ParamSelect, RangeFilter } from '@/components/filters';
import { AgentTabs } from '@/components/analytics/AgentTabs';
import { fmtDuration } from '@/lib/format';

export const metadata = { title: 'Agent daily activity' };

const dayLabel = (d: string) => new Date(`${d}T12:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

function In({ n }: { n: number }) { return n ? <span className="font-medium text-red-700">{n}</span> : <span className="text-ink-faint">0</span>; }
function Out({ n }: { n: number }) { return n ? <span className="font-medium text-emerald-700">{n}</span> : <span className="text-ink-faint">0</span>; }
function Num({ n }: { n: number }) { return n ? <>{n}</> : <span className="text-ink-faint">0</span>; }

export default async function AgentActivityPage(props: { searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const s = await requireSession();
  if (!s.permissions.has('reports.view')) redirect('/forbidden');
  const f = parseActivityFilters(searchParams);
  const { rows, opts } = await withOrg(s.org.id, async (db) => {
    const [rows, opts] = await Promise.all([getDailyActivity(db, s, f), getFilterOptions(db, s)]);
    return { rows, opts };
  });
  const totals = totalsByAgent(rows);
  const grand = totals.reduce((a, r) => ({
    calls_in: a.calls_in + r.calls_in, calls_out: a.calls_out + r.calls_out, missed: a.missed + r.missed, talk: a.talk + r.talk_seconds,
    chat_replies: a.chat_replies + r.chat_replies, emails: a.emails + r.emails,
  }), { calls_in: 0, calls_out: 0, missed: 0, talk: 0, chat_replies: 0, emails: 0 });
  const canExport = s.permissions.has('reports.export');
  const agentQ = (id: string | null, day?: string) => `/inbox${withParams({} as SP, day ? { agent: id ?? undefined, from: day, to: day } : { agent: id ?? undefined, range: searchParams.from ? undefined : (searchParams.range as string | undefined) ?? '7d', from: searchParams.from as string | undefined, to: searchParams.to as string | undefined })}`;

  return (
    <div className="space-y-5">
      <PageHeader title="Agent daily activity"
        description={<>Calls received (<span className="font-medium text-red-700">incoming</span>) and made (<span className="font-medium text-emerald-700">outgoing</span>), chats and messages replied, and emails — per agent, per day · <span className="font-medium text-ink">{f.rangeLabel}</span></>}
        actions={<>
          {opts.teams.length > 1 && <ParamSelect name="team" placeholder="All teams" options={opts.teams.map((t) => ({ value: t.id, label: t.name }))} />}
          {opts.agents.length > 0 && <ParamSelect name="agent" placeholder="All agents" options={opts.agents.map((a) => ({ value: a.id, label: a.name }))} />}
          <RangeFilter defaultPreset="7d" />
          <ClearFilters />
          {canExport && <a href={`/api/export/agent-activity${withParams(searchParams, {})}`} className={buttonClass('secondary', 'md')}><Download size={14} /> Download Excel</a>}
        </>} />
      <AgentTabs current="/agents/activity" searchParams={searchParams} />

      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Incoming calls" value={String(grand.calls_in)} tone="bad" />
        <KpiCard label="Outgoing calls" value={String(grand.calls_out)} tone="good" />
        <KpiCard label="Missed / not answered" value={String(grand.missed)} tone="warn" />
        <KpiCard label="Talk time" value={fmtDuration(grand.talk)} />
        <KpiCard label="Chat / WhatsApp replies" value={String(grand.chat_replies)} sub="messages sent by agents" />
        <KpiCard label="Emails" value={String(grand.emails)} />
      </div>

      <Card>
        <CardHeader title="Totals per agent" subtitle="Whole selected period. Click a number to open those conversations." />
        {totals.length === 0 ? <EmptyState title="No activity in this period" description="Import calls and chats from Integrations, or choose a wider date range." /> : (
          <Table>
            <THead><tr>
              <th className="th">Agent</th><th className="th">Active days</th><th className="th">Incoming calls</th><th className="th">Outgoing calls</th>
              <th className="th">Answered</th><th className="th">Missed</th><th className="th">Talk time</th><th className="th">Avg / day</th>
              <th className="th">Chats</th><th className="th">Messages replied</th><th className="th">Emails</th><th className="th">Email replies</th>
            </tr></THead>
            <TBody>
              {totals.map((r) => (
                <tr key={r.agent_id ?? 'none'} className="hover:bg-brand-50/40">
                  <td className="td font-medium">{r.agent_id ? <Link href={agentQ(r.agent_id)} className="hover:text-brand">{r.agent_name}</Link> : <span className="text-ink-muted">Unassigned (add agent mobile numbers in Team)</span>}</td>
                  <td className="td tabular-nums">{r.days}</td>
                  <td className="td tabular-nums"><In n={r.calls_in} /></td>
                  <td className="td tabular-nums"><Out n={r.calls_out} /></td>
                  <td className="td tabular-nums"><Num n={r.answered} /></td>
                  <td className="td tabular-nums">{r.missed ? <span className="text-amber-800">{r.missed}</span> : <span className="text-ink-faint">0</span>}</td>
                  <td className="td whitespace-nowrap tabular-nums">{fmtDuration(r.talk_seconds)}</td>
                  <td className="td tabular-nums">{(r.total / Math.max(1, r.days)).toFixed(1)}</td>
                  <td className="td tabular-nums"><Num n={r.chats} /></td>
                  <td className="td tabular-nums"><Num n={r.chat_replies} /></td>
                  <td className="td tabular-nums"><Num n={r.emails} /></td>
                  <td className="td tabular-nums"><Num n={r.email_replies} /></td>
                </tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Day by day" subtitle="IST calendar days. Message replies are counted on the day they were sent." />
        {rows.length === 0 ? null : (
          <Table>
            <THead><tr>
              <th className="th">Date</th><th className="th">Agent</th><th className="th">Incoming</th><th className="th">Outgoing</th>
              <th className="th">Missed</th><th className="th">Talk time</th><th className="th">Chats</th><th className="th">Messages replied</th><th className="th">Emails</th><th className="th">Total</th>
            </tr></THead>
            <TBody>
              {rows.map((r) => (
                <tr key={`${r.day}-${r.agent_id}`} className="hover:bg-brand-50/40">
                  <td className="td whitespace-nowrap">{dayLabel(r.day)}</td>
                  <td className="td">{r.agent_id ? <Link href={agentQ(r.agent_id, r.day)} className="hover:text-brand">{r.agent_name}</Link> : <span className="text-ink-muted">Unassigned</span>}</td>
                  <td className="td tabular-nums"><In n={r.calls_in} /></td>
                  <td className="td tabular-nums"><Out n={r.calls_out} /></td>
                  <td className="td tabular-nums">{r.missed ? <span className="text-amber-800">{r.missed}</span> : <span className="text-ink-faint">0</span>}</td>
                  <td className="td whitespace-nowrap tabular-nums">{fmtDuration(r.talk_seconds)}</td>
                  <td className="td tabular-nums"><Num n={r.chats} /></td>
                  <td className="td tabular-nums"><Num n={r.chat_replies} /></td>
                  <td className="td tabular-nums"><Num n={r.emails} /></td>
                  <td className="td font-medium tabular-nums">{r.total}</td>
                </tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
