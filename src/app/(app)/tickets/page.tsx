import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BadgeCheck, Download, ShieldAlert } from 'lucide-react';
import { requireSession } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { withParams, type SP } from '@/lib/filters';
import { getFilterOptions } from '@/lib/repos/analytics';
import { listTickets, parseTicketFilters, TICKET_PRIORITIES, TICKET_STATUSES, TICKET_STATUS_LABELS, type TicketRow } from '@/lib/repos/tickets';
import { RESOLUTION_TYPES, RESOLUTION_TYPE_LABELS, type ResolutionType } from '@/lib/orders/tickets';
import { Badge, Card, CardHeader, DemoBadge, EmptyState, KpiCard, PageHeader, Table, TBody, THead, buttonClass, type Tone } from '@/components/ui';
import { ClearFilters, ParamSearch, ParamSelect, RangeFilter } from '@/components/filters';
import { Pagination } from '@/components/pagination';
import { ActionForm, SubmitButton } from '@/components/interaction/ActionForm';
import { DirectionBadge } from '@/components/interaction/InteractionListView';
import { CHANNEL_LABELS, type Channel } from '@/lib/constants';
import { fmtDateTime, fmtDuration, titleCase } from '@/lib/format';
import { updateTicketAction } from './actions';

export const metadata = { title: 'Tickets' };

const PRIORITY_TONE: Record<string, Tone> = { urgent: 'bad', high: 'warn', medium: 'info', low: 'muted' };
const STATUS_TONE: Record<string, Tone> = { open: 'warn', pending: 'info', escalated: 'bad', resolved: 'good', closed: 'muted' };
const ACTION_TONE: Partial<Record<ResolutionType, Tone>> = { refund: 'bad', replacement: 'warn', return: 'warn', redelivery: 'info', escalated: 'bad', information: 'good' };

function ActionBadge({ t }: { t: string | null }) {
  const k = (t ?? 'none') as ResolutionType;
  return <Badge tone={ACTION_TONE[k] ?? 'neutral'}>{RESOLUTION_TYPE_LABELS[k] ?? titleCase(k)}</Badge>;
}

function EditTicket({ r }: { r: TicketRow }) {
  return (
    <details className="group">
      <summary className="cursor-pointer text-2xs text-brand hover:underline">Edit</summary>
      <ActionForm action={updateTicketAction} hidden={{ ticketId: r.id }} className="mt-2 w-64 space-y-2 rounded-lg border border-line bg-white p-2 shadow-sm">
        <label className="block text-2xs text-ink-muted">Status
          <select name="status" defaultValue={r.status} className="input mt-0.5 w-full text-xs">
            {TICKET_STATUSES.map((x) => <option key={x} value={x}>{TICKET_STATUS_LABELS[x]}</option>)}
          </select>
        </label>
        <label className="block text-2xs text-ink-muted">Action type
          <select name="resolutionType" defaultValue={r.resolution_type ?? 'none'} className="input mt-0.5 w-full text-xs">
            {RESOLUTION_TYPES.map((x) => <option key={x} value={x}>{RESOLUTION_TYPE_LABELS[x]}</option>)}
          </select>
        </label>
        <label className="block text-2xs text-ink-muted">Problem
          <textarea name="problem" defaultValue={r.problem ?? ''} rows={2} maxLength={1000} className="input mt-0.5 h-auto w-full py-1 text-xs" />
        </label>
        <label className="block text-2xs text-ink-muted">What was done
          <textarea name="actionTaken" defaultValue={r.action_taken ?? ''} rows={2} maxLength={1000} className="input mt-0.5 h-auto w-full py-1 text-xs" />
        </label>
        <SubmitButton variant="primary">Save ticket</SubmitButton>
      </ActionForm>
    </details>
  );
}

export default async function TicketsPage(props: { searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const s = await requireSession();
  if (!s.permissions.has('interactions.view')) redirect('/forbidden');
  const f = parseTicketFilters(searchParams);
  const { data, opts } = await withOrg(s.org.id, async (db) => {
    const [data, opts] = await Promise.all([listTickets(db, s, f), getFilterOptions(db, s)]);
    return { data, opts };
  });
  const canExport = s.permissions.has('reports.export');
  const exportQs = withParams(searchParams, { page: undefined });
  const sum = (o: Record<string, number>, keys: string[]) => keys.reduce((a, k) => a + (o[k] ?? 0), 0);
  const all = Object.values(data.statuses).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-5">
      <PageHeader title="Tickets"
        description={<>One ticket per call, chat and email — the customer’s problem and what the agent did (refund, replacement…) · <span className="font-medium text-ink">{f.rangeLabel}</span></>}
        actions={<>
          <ParamSearch placeholder="Order ID, customer, problem…" />
          <ParamSelect name="status" placeholder="All statuses" options={TICKET_STATUSES.map((x) => ({ value: x, label: TICKET_STATUS_LABELS[x] }))} />
          <ParamSelect name="action" placeholder="All actions" options={RESOLUTION_TYPES.map((x) => ({ value: x, label: RESOLUTION_TYPE_LABELS[x] }))} />
          <ParamSelect name="priority" placeholder="All priorities" options={TICKET_PRIORITIES.map((x) => ({ value: x, label: titleCase(x) }))} />
          <ParamSelect name="channel" placeholder="All channels" options={[{ value: 'call', label: 'Calls' }, { value: 'chat', label: 'Chat & WhatsApp' }, { value: 'email', label: 'Email' }]} />
          {opts.agents.length > 0 && <ParamSelect name="agent" placeholder="All agents" options={opts.agents.map((a) => ({ value: a.id, label: a.name }))} />}
          <RangeFilter />
          <ClearFilters />
          {canExport && (
            <a href={`/api/export/tickets${exportQs}`} className={buttonClass('secondary', 'md')} title="Download these tickets as an Excel sheet">
              <Download size={14} /> Download Excel
            </a>
          )}
        </>} />

      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Tickets" value={String(all)} sub="matching filters" />
        <KpiCard label="Open / pending" value={String(sum(data.statuses, ['open', 'pending']))} tone="warn" />
        <KpiCard label="Escalated" value={String(data.statuses.escalated ?? 0)} tone="bad" />
        <KpiCard label="Refunds" value={String(data.actions.refund ?? 0)} />
        <KpiCard label="Replacements" value={String(data.actions.replacement ?? 0)} />
        <KpiCard label="Urgent / high" value={String(sum(data.priorities, ['urgent', 'high']))} tone="bad" />
      </div>

      <Card>
        <CardHeader title={`${data.total} ticket${data.total === 1 ? '' : 's'}`} subtitle="Created automatically after each conversation is analysed. Editing a ticket keeps your changes when the conversation is re-analysed." />
        {data.rows.length === 0 ? (
          <EmptyState title="No tickets yet" description="Tickets appear after calls, chats and emails are transcribed and analysed. Try a wider date range." />
        ) : (
          <Table>
            <THead>
              <tr>
                <th className="th">Order / ticket</th><th className="th">Date</th><th className="th">Type</th><th className="th">Customer</th>
                <th className="th">Agent</th><th className="th">Problem</th><th className="th">What the agent did</th>
                <th className="th">Priority</th><th className="th">Status</th><th className="th"><span className="sr-only">Edit</span></th>
              </tr>
            </THead>
            <TBody>
              {data.rows.map((r) => (
                <tr key={r.id} className="align-top hover:bg-brand-50/40">
                  <td className="td min-w-[9rem]">
                    {r.interaction_id ? (
                      <Link href={`/inbox/${r.interaction_id}`} className="font-medium text-ink hover:text-brand">
                        {r.order_ref ? <span className="inline-flex items-center gap-1">{r.order_ref}{r.order_verified && <BadgeCheck size={13} className="text-emerald-600" aria-label="Verified in Shopify" />}</span> : <span className="text-ink-muted">No order ID</span>}
                      </Link>
                    ) : <span className="font-medium">{r.order_ref ?? '—'}</span>}
                    <p className="text-2xs text-ink-faint">{r.external_id ?? r.interaction_ref}{r.is_demo && <> · <DemoBadge /></>}</p>
                  </td>
                  <td className="td whitespace-nowrap text-xs">{fmtDateTime(r.opened_at)}</td>
                  <td className="td whitespace-nowrap">
                    {r.direction && r.channel ? <DirectionBadge direction={r.direction as 'inbound' | 'outbound'} channel={r.channel} /> : null}
                    <p className="mt-0.5 text-2xs text-ink-muted">{r.channel ? CHANNEL_LABELS[r.channel as Channel] ?? r.channel : ''}{r.duration_seconds ? ` · ${fmtDuration(r.duration_seconds)}` : r.call_status && r.call_status !== 'answered' ? ` · ${r.call_status}` : ''}</p>
                  </td>
                  <td className="td min-w-[8rem]"><p className="text-ink">{r.customer_name ?? 'Unknown'}</p><p className="text-2xs text-ink-muted">{r.customer_phone ?? r.customer_email ?? ''}</p></td>
                  <td className="td whitespace-nowrap">{r.agent_name ?? <span className="text-ink-faint">Unassigned</span>}</td>
                  <td className="td min-w-[14rem] max-w-[22rem] text-xs">
                    {r.category && <p className="font-medium text-ink">{r.category}</p>}
                    <p className="line-clamp-3 text-ink-muted">{r.problem ?? '—'}</p>
                    {r.critical_alerts > 0 && <p className="mt-1 inline-flex items-center gap-1 text-2xs font-medium text-red-700"><ShieldAlert size={12} /> {r.critical_alerts} critical alert{r.critical_alerts > 1 ? 's' : ''}</p>}
                  </td>
                  <td className="td min-w-[12rem] max-w-[20rem] text-xs"><ActionBadge t={r.resolution_type} /><p className="mt-1 line-clamp-3 text-ink-muted">{r.action_taken ?? ''}</p></td>
                  <td className="td"><Badge tone={PRIORITY_TONE[r.priority] ?? 'neutral'}>{titleCase(r.priority)}</Badge></td>
                  <td className="td"><Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{TICKET_STATUS_LABELS[r.status] ?? titleCase(r.status)}</Badge>{!r.auto_created && <p className="mt-0.5 text-2xs text-ink-faint">edited</p>}</td>
                  <td className="td"><EditTicket r={r} /></td>
                </tr>
              ))}
            </TBody>
          </Table>
        )}
        <Pagination searchParams={searchParams} page={f.page} pageSize={f.pageSize} total={data.total} basePath="/tickets" />
      </Card>
    </div>
  );
}
