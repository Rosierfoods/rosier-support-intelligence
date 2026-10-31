import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BadgeCheck, CheckCircle2, Download, Headphones, PlayCircle } from 'lucide-react';
import { requireSession } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { withParams, type SP } from '@/lib/filters';
import { getFilterOptions } from '@/lib/repos/analytics';
import { getListenList, MUST_LISTEN, parseListenFilters, SHOULD_LISTEN, type ListenRow } from '@/lib/repos/listen';
import { Badge, Card, CardHeader, DemoBadge, EmptyState, KpiCard, Notice, PageHeader, buttonClass } from '@/components/ui';
import { ClearFilters, ParamSelect, RangeFilter } from '@/components/filters';
import { ActionForm, SubmitButton } from '@/components/interaction/ActionForm';
import { DirectionBadge } from '@/components/interaction/InteractionListView';
import { ChannelBadge } from '@/components/badges';
import { fmtDateTime, fmtDuration, relTime } from '@/lib/format';
import { markListenedAction } from './actions';

export const metadata = { title: 'Calls to listen' };

function Item({ r }: { r: ListenRow }) {
  const isCall = r.channel === 'call';
  return (
    <li className="flex flex-col gap-3 border-b border-line px-4 py-4 last:border-0 lg:flex-row lg:items-start">
      <div className="w-24 shrink-0">
        <Badge tone={r.level === 'must' ? 'bad' : 'warn'}>{r.level === 'must' ? 'Must listen' : 'Should listen'}</Badge>
        <p className="mt-1 text-2xs text-ink-faint">priority {r.score}</p>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/inbox/${r.id}`} className="inline-flex items-center gap-1 text-[15px] font-semibold text-ink hover:text-brand">
            {r.order_ref ? <>Order {r.order_ref}{r.order_verified && <BadgeCheck size={14} className="text-emerald-600" aria-label="Verified in Shopify" />}</> : 'No order ID'}
          </Link>
          <DirectionBadge direction={r.direction} channel={r.channel} />
          <ChannelBadge channel={r.channel} />
          {r.is_demo && <DemoBadge />}
          <span className="text-xs text-ink-muted">{fmtDateTime(r.occurred_at)}{isCall && r.duration_seconds ? ` · ${fmtDuration(r.duration_seconds)}` : ''}</span>
        </div>
        <p className="mt-1 text-sm text-ink">
          <span className="font-medium">{r.customer_name ?? 'Unknown customer'}</span>{r.customer_phone && <span className="text-ink-muted"> · {r.customer_phone}</span>}
          <span className="text-ink-muted"> with </span><span className="font-medium">{r.agent_name ?? 'Unassigned agent'}</span>
          {r.issue && <span className="text-ink-muted"> · {r.issue}</span>}
        </p>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {r.reasons.map((x) => <li key={x} className="rounded-md bg-red-50 px-2 py-0.5 text-xs text-red-800 ring-1 ring-inset ring-red-100">{x}</li>)}
        </ul>
        {r.summary && <p className="mt-2 line-clamp-2 text-xs text-ink-muted">{r.summary}</p>}
        {r.founder_reviewed_at && (
          <p className="mt-2 text-xs text-emerald-800">Listened {relTime(r.founder_reviewed_at)}{r.reviewed_by ? ` by ${r.reviewed_by}` : ''}{r.founder_note ? ` — “${r.founder_note}”` : ''}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-col gap-2 lg:w-56">
        <Link href={`/inbox/${r.id}`} className={buttonClass('primary', 'sm', 'justify-center')}>
          {isCall ? <><PlayCircle size={14} /> {r.recording_available ? 'Listen to call' : 'Open call'}</> : <><Headphones size={14} /> Read conversation</>}
        </Link>
        {r.founder_reviewed_at ? (
          <ActionForm action={markListenedAction} hidden={{ interactionId: r.id, listened: '0' }}>
            <SubmitButton className="w-full justify-center">Move back to list</SubmitButton>
          </ActionForm>
        ) : (
          <ActionForm action={markListenedAction} hidden={{ interactionId: r.id, listened: '1' }} className="space-y-1.5">
            <input name="note" maxLength={1000} placeholder="Note for the team (optional)" className="input h-8 text-xs" />
            <SubmitButton className="w-full justify-center"><CheckCircle2 size={14} /> Mark as listened</SubmitButton>
          </ActionForm>
        )}
      </div>
    </li>
  );
}

export default async function ListenPage(props: { searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const s = await requireSession();
  if (!s.permissions.has('reports.view')) redirect('/forbidden');
  const f = parseListenFilters(searchParams);
  const { data, opts } = await withOrg(s.org.id, async (db) => {
    const [data, opts] = await Promise.all([getListenList(db, s, f), getFilterOptions(db, s)]);
    return { data, opts };
  });
  const canExport = s.permissions.has('reports.export');
  return (
    <div className="space-y-5">
      <PageHeader title="Calls to listen"
        description={<>The conversations a founder should personally hear or read — picked by AI from every call, chat and email · <span className="font-medium text-ink">{f.rangeLabel}</span></>}
        actions={<>
          <ParamSelect name="show" placeholder="Not listened yet" options={[{ value: 'done', label: 'Already listened' }, { value: 'all', label: 'All flagged' }]} />
          <ParamSelect name="channel" placeholder="Calls, chats & emails" options={[{ value: 'call', label: 'Calls only' }, { value: 'chat', label: 'Chat & WhatsApp' }, { value: 'email', label: 'Email' }]} />
          {opts.agents.length > 0 && <ParamSelect name="agent" placeholder="All agents" options={opts.agents.map((a) => ({ value: a.id, label: a.name }))} />}
          <RangeFilter defaultPreset="7d" />
          <ClearFilters />
          {canExport && <a href={`/api/export/listen${withParams(searchParams, {})}`} className={buttonClass('secondary', 'md')}><Download size={14} /> Download Excel</a>}
        </>} />

      <div className="grid gap-3 sm:grid-cols-3">
        <KpiCard label="Must listen" value={String(data.counts.must)} tone={data.counts.must ? 'bad' : undefined} sub="not listened yet" />
        <KpiCard label="Should listen" value={String(data.counts.should)} tone={data.counts.should ? 'warn' : undefined} sub="not listened yet" />
        <KpiCard label="Listened" value={String(data.counts.done)} tone="good" sub="in this period" />
      </div>

      <Notice tone="info" title="How calls are picked">
        Each analysed conversation gets a priority score. <b>Must listen</b> (score {MUST_LISTEN}+) and <b>Should listen</b> ({SHOULD_LISTEN}–{MUST_LISTEN - 1}) are shown.
        Points come from critical/high alerts, serious product complaints, wrong information given by the agent, policy not followed, poor handling,
        an upset customer, escalations, refunds/replacements, customers contacting us again and again, and very long calls.
        A summary of new “must listen” calls is sent to admins every morning.
      </Notice>

      <Card>
        <CardHeader title={f.show === 'done' ? 'Already listened' : f.show === 'all' ? 'All flagged conversations' : 'Waiting for you'} subtitle="Highest priority first." />
        {data.rows.length === 0 ? (
          <EmptyState title={f.show === 'todo' ? 'Nothing waiting — all caught up' : 'Nothing here'} description="Calls appear here after they are transcribed and analysed. Try a wider date range." />
        ) : <ul>{data.rows.map((r) => <Item key={r.id} r={r} />)}</ul>}
      </Card>
    </div>
  );
}
