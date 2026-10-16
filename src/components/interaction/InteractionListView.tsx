import Link from 'next/link';
import { Download } from 'lucide-react';
import type { Session } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { parsePage, withParams, type SP } from '@/lib/filters';
import { getFilterOptions, listInteractions, parseInteractionFilters, type InteractionRow } from '@/lib/repos/interactions';
import {
  CHANNEL_LABELS, PLATFORM_LABELS, PROCESSING_LABELS, PROCESSING_STATUSES, RESOLUTION_STATUSES, REVIEW_STATUSES, SENTIMENTS, SEVERITIES, type Channel,
} from '@/lib/constants';
import { Card, DemoBadge, EmptyState, PageHeader, Table, TBody, THead, buttonClass, Badge } from '@/components/ui';
import { ClearFilters, ParamSearch, ParamSelect, RangeFilter } from '@/components/filters';
import { Pagination, SortLink } from '@/components/pagination';
import { ChannelBadge, ProcessingBadge, ResolutionBadge, ScoreBadge, SentimentBadge, SeverityBadge } from '@/components/badges';
import { fmtDateTime, fmtDuration, titleCase } from '@/lib/format';
import { ParamToggle, ScoreRangeFilter } from './ListControls';

export type ListVariant = 'all' | 'call' | 'chat' | 'email';

const PRESETS: Record<ListVariant, Channel[]> = { all: [], call: ['call'], chat: ['chat', 'whatsapp'], email: ['email'] };
const CALL_STATUS_LABELS: Record<string, string> = { answered: 'Answered', missed: 'Missed', voicemail: 'Voicemail', failed: 'Failed' };

export async function InteractionListView({ s, searchParams, basePath, title, description, variant }: {
  s: Session; searchParams: SP; basePath: string; title: string; description: string; variant: ListVariant;
}) {
  const f = parseInteractionFilters(searchParams, { presetChannels: PRESETS[variant] });
  const { page, pageSize, offset } = parsePage(searchParams, 25);
  const { list, opts } = await withOrg(s.org.id, async (db) => ({
    list: await listInteractions(db, s, f, { pageSize, offset }),
    opts: await getFilterOptions(db, s),
  }));
  const canExport = s.permissions.has('reports.export');
  const exportQs = withParams(searchParams, { page: undefined, ...(variant !== 'all' && !searchParams.channel ? { preset: variant } : {}) });
  const subOptions = opts.categories.filter((c) => c.parent_code && (!f.category || c.parent_code === f.category));
  const catName = new Map(opts.categories.filter((c) => !c.parent_code).map((c) => [c.code, c.name]));
  const hasDemo = list.rows.some((r) => r.is_demo);
  const showCall = variant === 'call';
  const channelOpts = (variant === 'all' ? (['call', 'chat', 'whatsapp', 'email'] as Channel[]) : PRESETS[variant]).map((c) => ({ value: c, label: CHANNEL_LABELS[c] }));

  return (
    <div className="space-y-4">
      <PageHeader title={title}
        description={<>{description} · <span className="font-medium text-ink">{list.total.toLocaleString('en-IN')}</span> interactions · {f.range.label}{hasDemo && <> · <DemoBadge /></>}</>}
        actions={<>
          <RangeFilter />
          {canExport && (
            <a href={`/api/export/interactions${exportQs}`} className={buttonClass('secondary', 'md')} title="Download the filtered list as CSV (max 10,000 rows)">
              <Download size={14} /> Export CSV
            </a>
          )}
        </>} />

      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <ParamSearch placeholder={s.permissions.has('customer_pii.view')
            ? 'Search ID, agent, customer phone/email, subject, transcript or message text…'
            : 'Search ID, agent, subject, transcript or message text…'} />
          {channelOpts.length > 1 && <ParamSelect name="channel" placeholder="All channels" options={channelOpts} />}
          {showCall && <ParamSelect name="call_status" placeholder="Any call status" options={Object.entries(CALL_STATUS_LABELS).map(([value, label]) => ({ value, label }))} />}
          <ParamSelect name="agent" placeholder="All agents" options={opts.agents.map((a) => ({ value: a.id, label: a.name }))} />
          {s.scope === 'all' && <ParamSelect name="team" placeholder="All teams" options={opts.teams.map((t) => ({ value: t.id, label: t.name }))} />}
          {opts.platforms.length > 1 && <ParamSelect name="platform" placeholder="All platforms" options={opts.platforms.map((p) => ({ value: p, label: PLATFORM_LABELS[p] ?? p }))} />}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ParamSelect name="category" placeholder="Any issue category" options={opts.categories.filter((c) => !c.parent_code).map((c) => ({ value: c.code, label: c.name }))} />
          <ParamSelect name="subcategory" placeholder="Any subcategory" className="max-w-[14rem]"
            options={subOptions.map((c) => ({ value: c.code, label: f.category ? c.name : `${catName.get(c.parent_code!) ?? ''} › ${c.name}` }))} />
          <ParamSelect name="product" placeholder="Any product" options={opts.products.map((p) => ({ value: p, label: p }))} />
          <ParamSelect name="severity" placeholder="Any alert severity" options={SEVERITIES.map((v) => ({ value: v, label: `${titleCase(v)} alert` }))} />
          <ParamSelect name="sentiment" placeholder="Any sentiment" options={SENTIMENTS.map((v) => ({ value: v, label: titleCase(v) }))} />
          <ParamSelect name="resolution" placeholder="Any resolution" options={[
            { value: 'open,pending,escalated,unresolved', label: 'Not resolved (any)' },
            ...RESOLUTION_STATUSES.map((v) => ({ value: v, label: titleCase(v) }))]} />
          <ParamSelect name="review" placeholder="Any review status" options={[
            { value: 'reviewed,corrected', label: 'Human reviewed (any)' },
            ...REVIEW_STATUSES.map((v) => ({ value: v, label: titleCase(v) }))]} />
          <ParamSelect name="processing" placeholder="Any processing status" options={PROCESSING_STATUSES.map((v) => ({ value: v, label: PROCESSING_LABELS[v] }))} />
          <ScoreRangeFilter />
          <ParamToggle name="complaints" label="Complaints only" />
          <ClearFilters />
        </div>
      </Card>

      <Card>
        {list.rows.length ? (
          <Table>
            <THead>
              <tr>
                <th className="th">ID</th>
                <th className="th"><SortLink searchParams={searchParams} basePath={basePath} field="occurred_at" label="Date / channel" /></th>
                <th className="th">Customer</th>
                <th className="th">Agent</th>
                {showCall && <><th className="th">Call</th><th className="th">Duration</th><th className="th">Transcript</th></>}
                <th className="th">Primary issue / product</th>
                <th className="th">Sentiment</th>
                <th className="th"><SortLink searchParams={searchParams} basePath={basePath} field="quality_score" label="Score" /></th>
                {!showCall && <th className="th"><SortLink searchParams={searchParams} basePath={basePath} field="first_response_seconds" label="1st response" /></th>}
                <th className="th">Resolution</th>
                <th className="th">Processing</th>
                <th className="th">Alerts</th>
              </tr>
            </THead>
            <TBody>
              {list.rows.map((r) => <Row key={r.id} r={r} showCall={showCall} variant={variant} />)}
            </TBody>
          </Table>
        ) : (
          <EmptyState title="No interactions match these filters"
            description="Try widening the date range or clearing some filters. New interactions appear here as integrations sync."
            action={<Link href={basePath} className="text-sm text-brand hover:underline">Clear all filters</Link>} />
        )}
        <Pagination searchParams={searchParams} page={page} pageSize={pageSize} total={list.total} basePath={basePath} />
      </Card>
      {!s.permissions.has('customer_pii.view') && (
        <p className="text-2xs text-ink-faint">Customer phone numbers and emails are masked for your role.</p>
      )}
    </div>
  );
}

function Row({ r, showCall, variant }: { r: InteractionRow; showCall: boolean; variant: ListVariant }) {
  const href = `/inbox/${r.id}`;
  return (
    <tr className="hover:bg-brand-50/40">
      <td className="td whitespace-nowrap">
        <Link href={href} className="font-medium text-ink hover:text-brand">{r.ref}</Link>
        {r.is_demo && <div className="mt-0.5"><DemoBadge className="px-1 text-[10px]" /></div>}
      </td>
      <td className="td whitespace-nowrap">
        <p className="text-xs text-ink-muted">{fmtDateTime(r.occurred_at)}</p>
        <div className="mt-0.5"><ChannelBadge channel={r.channel} platform={r.source_platform} /></div>
      </td>
      <td className="td max-w-[11rem]">
        <p className="truncate">{r.customer_name ?? <span className="text-ink-faint">Unknown</span>}</p>
        {r.customer_contact && <p className="truncate text-2xs text-ink-muted">{r.customer_contact}</p>}
        {variant === 'email' && r.subject && <p className="truncate text-2xs text-ink-faint" title={r.subject}>{r.subject}</p>}
      </td>
      <td className="td whitespace-nowrap">{r.agent_name ?? <span className="text-ink-faint">Unassigned</span>}</td>
      {showCall && (
        <>
          <td className="td"><Badge tone={r.call_status === 'answered' ? 'good' : r.call_status === 'missed' ? 'warn' : r.call_status === 'failed' ? 'bad' : 'neutral'}>{titleCase(r.call_status)}</Badge></td>
          <td className="td whitespace-nowrap tabular-nums">{fmtDuration(r.duration_seconds)}</td>
          <td className="td whitespace-nowrap">
            {r.transcript_status ? <Badge tone={r.transcript_status === 'completed' ? 'good' : r.transcript_status === 'failed' ? 'bad' : 'info'}>{titleCase(r.transcript_status)}</Badge>
              : <span className="text-2xs text-ink-faint">{r.call_status === 'answered' ? (r.recording_available ? 'Not started' : 'No recording') : 'n/a'}</span>}
          </td>
        </>
      )}
      <td className="td max-w-[15rem]">
        {r.primary_category ? (
          <>
            <p className="truncate" title={r.primary_sub ?? r.primary_category}>{r.primary_sub ?? r.primary_category}</p>
            <p className="text-2xs text-ink-muted">{r.primary_sub ? r.primary_category : ''}{r.label_count > 1 && <span className="ml-1 rounded bg-stone-100 px-1 text-ink-muted">+{r.label_count - 1} more</span>}</p>
          </>
        ) : <span className="text-ink-faint">—</span>}
        {r.product && <p className="truncate text-2xs text-brand" title="Product">{r.product}</p>}
      </td>
      <td className="td"><SentimentBadge sentiment={r.sentiment} /></td>
      <td className="td"><ScoreBadge score={r.quality_score} band={r.quality_band} /></td>
      {!showCall && <td className="td whitespace-nowrap tabular-nums">{fmtDuration(r.first_response_seconds)}</td>}
      <td className="td"><ResolutionBadge status={r.resolution_status} /></td>
      <td className="td"><ProcessingBadge status={r.processing_status} /></td>
      <td className="td whitespace-nowrap">
        {r.open_flags > 0 && r.max_severity ? (
          <Link href={href} className="inline-flex items-center gap-1" title={`${r.open_flags} open alert(s)`}>
            <SeverityBadge severity={r.max_severity} /><span className="text-xs tabular-nums text-ink-muted">×{r.open_flags}</span>
          </Link>
        ) : <span className="text-ink-faint">—</span>}
      </td>
    </tr>
  );
}
