import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { requirePermission } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { sp, type SP } from '@/lib/filters';
import { getCategories, getInteractionDetail, type FlagRow, type InteractionDetail } from '@/lib/repos/interactions';
import { listReviewers } from '@/lib/repos/flags';
import { Badge, Card, CardBody, CardHeader, DemoBadge, KeyValue, Notice } from '@/components/ui';
import { ChannelBadge, ProcessingBadge, ResolutionBadge } from '@/components/badges';
import { fmtDateTime, fmtDuration, fmtMs, titleCase } from '@/lib/format';
import { CHANNEL_LABELS, OPEN_FLAG_STATUSES, PLATFORM_LABELS, PRODUCTS, type Channel } from '@/lib/constants';
import { CallTranscript } from '@/components/interaction/CallTranscript';
import { ChatThread, EmailThread } from '@/components/interaction/Threads';
import { ScrollToEvidence } from '@/components/interaction/ScrollToEvidence';
import { ActionForm, SubmitButton } from '@/components/interaction/ActionForm';
import { AiInsightsCard, FlagsCard, LabelsCard, QualityCard, ReviewCard } from '@/components/interaction/DetailPanels';
import type { FlagMarker } from '@/components/interaction/types';
import {
  addLabelAction, addNoteAction, correctEvaluationAction, removeLabelAction, retryProcessingAction, rootCauseAction, updateStatusAction,
} from './actions';
import { flagAction } from '../../quality/actions';

export async function generateMetadata(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return { title: `Interaction ${params.id.slice(0, 8)}` };
}

const VERIFIED_STATUSES = ['confirmed', 'coaching_assigned', 'resolved'];

/** Which source element (segment / message / email seq) a flag's evidence points to. */
function evidenceSeq(f: FlagRow, d: InteractionDetail): number | null {
  const ev = f.evidence_ref ?? {};
  if (d.interaction.channel === 'call') {
    if (typeof ev.segment_seq === 'number' && d.segments.some((s) => s.seq === ev.segment_seq)) return ev.segment_seq;
    if (typeof ev.start_ms === 'number') {
      const seg = d.segments.find((s) => ev.start_ms! >= s.start_ms && ev.start_ms! < s.end_ms)
        ?? [...d.segments].reverse().find((s) => s.start_ms <= ev.start_ms!);
      return seg?.seq ?? null;
    }
    return null;
  }
  if (d.interaction.channel === 'email') {
    const seq = ev.email_seq ?? ev.message_seq;
    if (typeof seq === 'number' && d.emails.some((e) => e.seq === seq)) return seq;
    if (ev.sent_at) return d.emails.find((e) => new Date(e.sent_at).getTime() === new Date(ev.sent_at!).getTime())?.seq ?? null;
    return null;
  }
  const seq = ev.message_seq;
  if (typeof seq === 'number' && d.messages.some((m) => m.seq === seq)) return seq;
  if (ev.sent_at) return d.messages.find((m) => new Date(m.sent_at).getTime() === new Date(ev.sent_at!).getTime())?.seq ?? null;
  return null;
}

export default async function InteractionDetailPage(props: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const s = await requirePermission('interactions.view');
  const data = await withOrg(s.org.id, async (db) => {
    const d = await getInteractionDetail(db, s, params.id);
    if (!d) return null;
    const needsReviewers = s.permissions.has('flags.assign');
    const needsCats = s.permissions.has('evaluations.correct');
    return {
      d,
      reviewers: needsReviewers ? (await listReviewers(db)).map((r) => ({ id: r.id, name: r.name })) : [],
      categories: needsCats ? await getCategories(db) : [],
    };
  });
  if (!data) notFound();
  const { d, reviewers, categories } = data;
  const i = d.interaction;
  const channel = i.channel as Channel;

  const perms = {
    review: s.permissions.has('flags.review'), assign: s.permissions.has('flags.assign'), coach: s.permissions.has('coaching.assign'),
    correct: s.permissions.has('evaluations.correct'), retry: s.permissions.has('processing.retry'), play: s.permissions.has('recordings.play'),
  };
  const canEditReview = perms.correct || perms.review;
  // Unverified AI alerts are only shown to reviewers; others see human-verified ones.
  const visibleFlags = perms.review ? d.flags : d.flags.filter((f) => VERIFIED_STATUSES.includes(f.status));
  const hiddenCount = d.flags.length - visibleFlags.length;

  // Evidence highlighting: ?flag=<id> → its evidence; else ?seg=<seq> (calls) / ?msg=<seq> (chat, WhatsApp, email).
  const flagParam = sp(searchParams, 'flag');
  const selected = visibleFlags.find((f) => f.id === flagParam) ?? null;
  let targetSeq: number | null = null;
  let focusLabel: string | null = null;
  if (selected) targetSeq = evidenceSeq(selected, d);
  else {
    const raw = channel === 'call' ? sp(searchParams, 'seg') : sp(searchParams, 'msg');
    if (raw !== undefined && /^\d+$/.test(raw)) { targetSeq = Number(raw); focusLabel = 'Search match'; }
  }
  const markers: Record<number, FlagMarker[]> = {};
  for (const f of visibleFlags) {
    const seq = evidenceSeq(f, d);
    if (seq === null) continue;
    (markers[seq] ??= []).push({ id: f.id, title: f.title, severity: f.severity, reason: f.reason, status: f.status });
  }
  const selectedMarker: FlagMarker | null = selected ? { id: selected.id, title: selected.title, severity: selected.severity, reason: selected.reason, status: selected.status } : null;
  const openFlags = visibleFlags.filter((f) => (OPEN_FLAG_STATUSES as string[]).includes(f.status)).length;

  const slaMinutes = Number((s.org.settings.sla.firstResponseMinutes as Record<string, number>)[channel] ?? 15);
  const transcriptFailed = d.transcript?.status === 'failed';
  const showRetry = perms.retry;
  const retryEmphasis = i.processing_status === 'failed' || i.processing_status === 'requires_review' || transcriptFailed;

  const productOptions = Array.from(new Set([...PRODUCTS, ...(i.product ? [i.product] : [])]));

  return (
    <div className="space-y-4">
      <ScrollToEvidence dep={selected?.id ?? (targetSeq !== null ? String(targetSeq) : null)} />
      <div>
        <Link href="/inbox" className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-brand"><ArrowLeft size={13} /> Unified Inbox</Link>
      </div>

      {/* ── Header ── */}
      <Card>
        <div className="flex flex-col gap-3 px-4 py-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-ink">{i.ref}</h1>
              {i.is_demo && <DemoBadge />}
              <ChannelBadge channel={channel} platform={i.source_platform} />
              <Badge tone="muted">{PLATFORM_LABELS[i.source_platform] ?? i.source_platform}</Badge>
              <ProcessingBadge status={i.processing_status} />
              <ResolutionBadge status={i.resolution_status} />
              {openFlags > 0 && <a href="#alerts"><Badge tone="warn">{openFlags} open alert{openFlags === 1 ? '' : 's'}</Badge></a>}
            </div>
            {i.subject && <p className="mt-1 text-sm text-ink">{i.subject}</p>}
            <KeyValue className="mt-3 sm:grid-cols-3 lg:grid-cols-4" items={[
              ['Date / time', fmtDateTime(i.occurred_at)],
              ['Agent', i.agent_id ? <Link href={`/agents/${i.agent_id}`} className="link">{i.agent_name}</Link> : 'Unassigned'],
              ['Team', i.team_name ?? '—'],
              ['Customer', <span key="c">{i.customer.name ?? 'Unknown'}{(i.customer.phone || i.customer.email) && <span className="block text-2xs text-ink-muted">{[i.customer.phone, i.customer.email].filter(Boolean).join(' · ')}</span>}</span>],
              ['Direction', titleCase(i.direction)],
              ['Ticket', i.ticket_ref ? `${i.ticket_ref}${i.ticket_status ? ` (${i.ticket_status})` : ''}` : '—'],
              ['Source record ID', <span key="sr" className="break-all font-mono text-xs">{i.source_record_id}</span>],
              ['First response', fmtDuration(i.first_response_seconds)],
            ]} />
          </div>
          {showRetry && (
            <ActionForm action={retryProcessingAction} hidden={{ interactionId: i.id }} className="shrink-0 lg:text-right">
              <SubmitButton variant={retryEmphasis ? 'primary' : 'secondary'} size="md" pendingLabel="Queuing…"><RefreshCw size={14} /> Retry processing</SubmitButton>
            </ActionForm>
          )}
        </div>
        {(i.processing_status === 'failed' || i.processing_status === 'requires_review') && (
          <div className="border-t border-line px-4 py-3">
            <Notice tone={i.processing_status === 'failed' ? 'bad' : 'warn'} title={i.processing_status === 'failed' ? 'Processing failed' : 'Requires human review'}>
              {i.processing_error ?? (i.processing_status === 'requires_review' ? 'The AI flagged low confidence or missing policy coverage. A reviewer should check this interaction.' : 'No error details were recorded.')}
              {!perms.retry && i.processing_status === 'failed' && ' Ask a CRM manager or quality analyst to retry.'}
            </Notice>
          </div>
        )}
      </Card>

      {selected && targetSeq === null && (
        <Notice tone="warn" title="Evidence location not found in the stored source">
          The alert’s excerpt is shown in the alert card: “{selected.excerpt}”. The original segment or message may not have been imported.
        </Notice>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]">
        {/* ── Main column: original source content ── */}
        <div className="min-w-0 space-y-4">
          {channel === 'call' && d.call && (
            <Card>
              <CardHeader title="Call details" subtitle="Provider metadata (source)" />
              <CardBody>
                <KeyValue className="sm:grid-cols-3 lg:grid-cols-6" items={[
                  ['Call status', titleCase(d.call.call_status)],
                  ['Duration', fmtDuration(d.call.duration_seconds)],
                  ['Ring time', fmtDuration(d.call.ring_seconds)],
                  ['From', d.call.from_number_masked ?? '—'],
                  ['To', d.call.to_number_masked ?? '—'],
                  ['Recording', d.call.recording_available ? 'Available' : 'Not available'],
                ]} />
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader
              title={channel === 'call' ? 'Transcript' : channel === 'email' ? 'Email thread' : `${CHANNEL_LABELS[channel]} conversation`}
              subtitle={channel === 'call'
                ? (d.transcript ? `${d.transcript.provider}${d.transcript.model ? ` · ${d.transcript.model}` : ''}${d.transcript.language ? ` · ${d.transcript.language}` : ''}${d.transcript.diarized ? ' · speaker-labelled' : ''} · original language preserved` : 'Original source content')
                : `Original source content · ${channel === 'email' ? d.emails.length : d.messages.length} messages in order`}
              actions={<Badge tone="neutral">Source</Badge>} />
            {channel === 'call' ? (
              d.call?.call_status && d.call.call_status !== 'answered' ? (
                <CardBody><p className="text-sm text-ink-muted">This call was <span className="font-medium text-ink">{d.call.call_status}</span> — there is no conversation to transcribe.</p></CardBody>
              ) : transcriptFailed || !d.transcript || d.transcript.status !== 'completed' ? (
                <CardBody className="space-y-2">
                  {transcriptFailed ? (
                    <Notice tone="bad" title="Transcription failed">{d.transcript?.error ?? 'The speech-to-text provider returned an error.'} {d.transcript?.attempt ? `(attempt ${d.transcript.attempt})` : ''}</Notice>
                  ) : d.transcript ? (
                    <Notice tone="info" title={`Transcription ${d.transcript.status}`}>The transcript will appear here when the speech-to-text job finishes.</Notice>
                  ) : (
                    <Notice tone="info" title="No transcript yet">{d.call?.recording_available ? 'The recording is queued for transcription.' : 'No authorised recording is available for this call, so it cannot be transcribed.'}</Notice>
                  )}
                  {perms.retry && d.call?.recording_available && (
                    <ActionForm action={retryProcessingAction} hidden={{ interactionId: i.id }}>
                      <SubmitButton variant="primary" pendingLabel="Queuing…"><RefreshCw size={13} /> Retry transcription</SubmitButton>
                    </ActionForm>
                  )}
                </CardBody>
              ) : (
                <CallTranscript interactionId={i.id} segments={d.segments}
                  audioSrc={perms.play && d.call?.recording_available && !d.call.demo_recording ? `/api/media/${i.id}` : null}
                  audioNote={!perms.play ? 'Recording playback is not permitted for your role.'
                    : !d.call?.recording_available ? 'No authorised recording is available for this call.'
                      : d.call.demo_recording ? 'Demo recording — synthetic calls have no audio. Timestamps are shown for reference.' : null}
                  targetSeq={targetSeq} selectedFlag={selectedMarker} markers={markers} fullTranslation={d.transcript.translation_en} focusLabel={focusLabel} />
              )
            ) : channel === 'email' ? (
              <EmailThread emails={d.emails} interactionId={i.id} targetSeq={targetSeq} selectedFlag={selectedMarker} markers={markers} focusLabel={focusLabel} />
            ) : (
              <ChatThread messages={d.messages} interactionId={i.id} targetSeq={targetSeq} selectedFlag={selectedMarker} markers={markers} slaMinutes={slaMinutes} focusLabel={focusLabel} />
            )}
          </Card>

          {d.attachments.length > 0 && (
            <Card>
              <CardHeader title="Attachments" subtitle="Metadata only — files are stored privately when retention allows" />
              <CardBody>
                <ul className="space-y-1 text-sm">{d.attachments.map((a) => <li key={a.id}>{a.file_name ?? 'Attachment'} <span className="text-2xs text-ink-muted">{a.mime_type ?? ''}</span></li>)}</ul>
              </CardBody>
            </Card>
          )}

          {d.feedback.length > 0 && (
            <Card>
              <CardHeader title="Customer feedback" subtitle="From feedback records" />
              <CardBody className="space-y-2 text-sm">
                {d.feedback.map((f: any, idx: number) => (
                  <p key={idx}>{f.csat ? `CSAT ${f.csat}/5` : ''}{f.nps !== null && f.nps !== undefined ? ` · NPS ${f.nps}` : ''}{f.comment ? ` — “${f.comment}”` : ''} <span className="text-2xs text-ink-faint">{fmtDateTime(f.received_at)}</span></p>
                ))}
              </CardBody>
            </Card>
          )}

          <QualityCard d={d} canCorrect={perms.correct} correctAction={correctEvaluationAction} />
        </div>

        {/* ── Side column: AI interpretation & review ── */}
        <aside className="min-w-0 space-y-4" aria-label="Analysis and review">
          <AiInsightsCard d={d} />
          <FlagsCard d={d} flags={visibleFlags} selectedId={selected?.id ?? null} perms={perms} reviewers={reviewers} flagAction={flagAction} hiddenCount={hiddenCount} />
          <LabelsCard d={d} canCorrect={perms.correct} products={productOptions} categories={categories}
            actions={{ add: addLabelAction, remove: removeLabelAction, rootCause: rootCauseAction }} />
          <ReviewCard d={d} canEdit={canEditReview} actions={{ status: updateStatusAction, note: addNoteAction }} />
        </aside>
      </div>
      {selected && <p className="sr-only" aria-live="polite">Showing evidence for alert {selected.title}{targetSeq !== null && channel === 'call' ? ` at ${fmtMs(d.segments.find((x) => x.seq === targetSeq)?.start_ms ?? 0)}` : ''}</p>}
    </div>
  );
}
