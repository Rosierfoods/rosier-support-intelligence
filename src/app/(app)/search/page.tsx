import Link from 'next/link';
import { Search as SearchIcon, Mic, MessageSquare, Inbox } from 'lucide-react';
import { requirePermission } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { withParams, type SP } from '@/lib/filters';
import { globalSearch, HL_START, HL_STOP, parseSearchFilters } from '@/lib/repos/search';
import { Badge, Card, CardHeader, DemoBadge, EmptyState, PageHeader } from '@/components/ui';
import { ChannelBadge, ResolutionBadge, ScoreBadge } from '@/components/badges';
import { ParamSelect, RangeFilter } from '@/components/filters';
import { ParamToggle } from '@/components/interaction/ListControls';
import { CHANNELS, CHANNEL_LABELS, PLATFORM_LABELS } from '@/lib/constants';
import { fmtDateTime, fmtMs } from '@/lib/format';

export const metadata = { title: 'Search' };

/** Render ts_headline output: split on sentinel markers, never as raw HTML. */
function Snippet({ text }: { text: string | null }) {
  if (!text) return null;
  const out: React.ReactNode[] = [];
  let rest = text;
  let k = 0;
  while (rest.length) {
    const a = rest.indexOf(HL_START);
    if (a < 0) { out.push(rest); break; }
    const b = rest.indexOf(HL_STOP, a);
    out.push(rest.slice(0, a));
    out.push(<mark key={k++} className="hl">{rest.slice(a + 1, b < 0 ? undefined : b)}</mark>);
    rest = b < 0 ? '' : rest.slice(b + 1);
  }
  return <>{out}</>;
}

export default async function SearchPage(props: { searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const s = await requirePermission('interactions.view');
  const f = parseSearchFilters(searchParams);
  const res = await withOrg(s.org.id, (db) => globalSearch(db, s, f));
  const threshold = s.org.settings.reviewThreshold;
  const examples: { label: string; href: string }[] = [
    { label: 'Conversations mentioning “ghee jar leaking”', href: '/search?q=ghee+jar+leaking' },
    { label: 'Customers who requested a refund in the last 30 days', href: '/inbox?category=refund&subcategory=refund.requested&range=30d' },
    { label: 'Replacement promised without following the SOP', href: s.permissions.has('flags.review') ? '/quality?rule=incorrect_refund_replacement_info' : '/search?q=replacement' },
    { label: 'Unresolved complaints for a team', href: '/inbox?complaints=1&resolution=open,pending,escalated,unresolved' },
    { label: `Calls with a human-confirmed quality score below ${threshold}`, href: `/calls?score_max=${threshold - 0.01}&review=reviewed,corrected&range=all` },
    { label: 'Refund mentioned in WhatsApp chats', href: '/search?q=refund&channel=whatsapp' },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Search" description={f.q ? <>Results for <span className="font-medium text-ink">“{f.q}”</span> · {res.total.toLocaleString('en-IN')} interactions · {res.segments.length} transcript segments · {res.messages.length} messages</> : 'Search transcripts, conversations, emails, issue labels and IDs'} />

      <Card className="p-3">
        <form action="/search" className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[16rem] flex-1">
            <SearchIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input name="q" defaultValue={f.q} placeholder={s.permissions.has('customer_pii.view') ? 'e.g. ghee jar leaking, RSI-24A9F1, refund delayed, customer phone…' : 'e.g. ghee jar leaking, RSI-24A9F1, refund delayed…'}
              className="input pl-9" aria-label="Search query" autoFocus={!f.q} />
          </div>
          {/* keep active chips when re-submitting */}
          {(['channel', 'range', 'from', 'to', 'below', 'unresolved'] as const).map((k) => typeof searchParams[k] === 'string' ? <input key={k} type="hidden" name={k} value={searchParams[k] as string} /> : null)}
          <button type="submit" className="h-9 rounded-lg bg-brand px-4 text-sm font-medium text-white hover:bg-[#5f3a00]">Search</button>
        </form>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ParamSelect name="channel" placeholder="All channels" options={CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] }))} />
          <RangeFilter defaultPreset="all" />
          <ParamToggle name="below" label={`Score below ${threshold}`} />
          <ParamToggle name="unresolved" label="Unresolved" />
        </div>
      </Card>

      {!f.q ? (
        <Card>
          <CardHeader title="Try a search" subtitle="Full-text search over transcripts, chat and email messages, issue labels, summaries and IDs. Original language (Hindi / Hinglish) is searchable." />
          <ul className="grid gap-2 p-4 sm:grid-cols-2">
            {examples.map((e) => (
              <li key={e.label}><Link href={e.href} className="block rounded-lg border border-line px-3 py-2.5 text-sm text-ink hover:border-brand-500/40 hover:bg-brand-50/40">{e.label} →</Link></li>
            ))}
          </ul>
          <p className="px-4 pb-4 text-2xs text-ink-faint">Tip: use quotes for an exact phrase (“jar leaking”), <code>or</code> between alternatives, and <code>-word</code> to exclude.</p>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader title={<span className="flex items-center gap-2"><Inbox size={15} className="text-brand-500" /> Interactions</span>}
              subtitle={res.total > res.interactions.length ? `Top ${res.interactions.length} of ${res.total.toLocaleString('en-IN')} by relevance` : `${res.total} match${res.total === 1 ? '' : 'es'}`}
              actions={res.total > 0 ? <Link href={`/inbox${withParams({ q: f.q, channel: f.channel, range: (searchParams.range as string) ?? 'all', from: searchParams.from as string, to: searchParams.to as string }, {})}`} className="text-xs text-brand hover:underline">Open all in inbox →</Link> : undefined} />
            {res.interactions.length ? (
              <ul className="divide-y divide-line">
                {res.interactions.map((r) => (
                  <li key={r.id}>
                    <Link href={`/inbox/${r.id}`} className="block px-4 py-3 hover:bg-brand-50/40">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-medium text-ink">{r.ref}</span>
                        {r.is_demo && <DemoBadge />}
                        <ChannelBadge channel={r.channel} platform={r.source_platform} />
                        <span className="text-ink-muted">{fmtDateTime(r.occurred_at)}</span>
                        <span className="text-ink-muted">· {r.agent_name ?? 'Unassigned'}</span>
                        <ScoreBadge score={r.quality_score} />
                        <ResolutionBadge status={r.resolution_status} />
                      </div>
                      {(r.subject || r.primary_issue) && <p className="mt-1 text-[13px] font-medium text-ink">{r.subject ?? r.primary_issue}</p>}
                      <p className="mt-1 text-[13px] leading-relaxed text-ink-muted"><Snippet text={r.snippet} /></p>
                      <p className="mt-1 text-2xs text-ink-faint">
                        Source: {PLATFORM_LABELS[r.source_platform] ?? r.source_platform} · record {r.source_record_id}
                        {r.primary_issue && r.subject ? ` · ${r.primary_issue}` : ''}
                        {r.customer_match && <> · <Badge tone="info">Customer match: {r.customer_match}</Badge></>}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <EmptyState title={`No interactions match “${f.q}”`} description="Check the spelling, remove filters, or try fewer words." />}
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader title={<span className="flex items-center gap-2"><Mic size={15} className="text-brand-500" /> Transcript segments</span>} subtitle="Opens the call at the matching timestamp" />
              {res.segments.length ? (
                <ul className="divide-y divide-line">
                  {res.segments.map((m) => (
                    <li key={`${m.interaction_id}-${m.seq}`}>
                      <Link href={`/inbox/${m.interaction_id}?seg=${m.seq}#evidence`} className="block px-4 py-2.5 hover:bg-brand-50/40">
                        <p className="flex flex-wrap items-center gap-2 text-2xs text-ink-muted">
                          <span className="font-medium text-ink">{m.ref}</span>{m.is_demo && <DemoBadge />}
                          <span className="font-mono text-brand">{fmtMs(m.start_ms)}</span>
                          <span className="font-semibold uppercase">{m.speaker === 'agent' ? 'Agent' : m.speaker === 'customer' ? 'Customer' : 'Speaker'}</span>
                          <span>{fmtDateTime(m.occurred_at)} · {m.agent_name ?? 'Unassigned'}</span>
                        </p>
                        <p className="mt-0.5 text-[13px] text-ink"><Snippet text={m.snippet} /></p>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : <p className="px-4 py-6 text-center text-sm text-ink-muted">No transcript matches.</p>}
            </Card>
            <Card>
              <CardHeader title={<span className="flex items-center gap-2"><MessageSquare size={15} className="text-brand-500" /> Chat, WhatsApp & email messages</span>} subtitle="Opens the thread at the matching message" />
              {res.messages.length ? (
                <ul className="divide-y divide-line">
                  {res.messages.map((m) => (
                    <li key={`${m.kind}-${m.interaction_id}-${m.seq}`}>
                      <Link href={`/inbox/${m.interaction_id}?msg=${m.seq}#evidence`} className="block px-4 py-2.5 hover:bg-brand-50/40">
                        <p className="flex flex-wrap items-center gap-2 text-2xs text-ink-muted">
                          <span className="font-medium text-ink">{m.ref}</span>{m.is_demo && <DemoBadge />}
                          <ChannelBadge channel={m.channel} />
                          <span className="font-semibold uppercase">{m.sender_type === 'agent' ? 'Agent' : m.sender_type === 'customer' ? 'Customer' : m.sender_type}</span>
                          <span>{fmtDateTime(m.sent_at)} · {m.agent_name ?? 'Unassigned'}</span>
                        </p>
                        <p className="mt-0.5 text-[13px] text-ink"><Snippet text={m.snippet} /></p>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : <p className="px-4 py-6 text-center text-sm text-ink-muted">No message matches.</p>}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
