import Link from 'next/link';
import clsx from 'clsx';
import { AlertTriangle, Clock, Paperclip } from 'lucide-react';
import type { AttachmentRow, EmailMessage, ThreadMessage } from '@/lib/repos/interactions';
import { fmtDateTime, fmtDuration, fmtTime } from '@/lib/format';
import type { FlagMarker } from './types';

const SEV_RING: Record<string, string> = {
  critical: 'ring-red-400', high: 'ring-amber-400', medium: 'ring-brand-500/60', low: 'ring-stone-300',
};

function FlagNote({ flag }: { flag: FlagMarker }) {
  return (
    <div className="mt-2 rounded-lg border border-amber-200 bg-white px-2.5 py-2 text-left text-xs text-ink">
      <p className="flex items-center gap-1 font-medium text-amber-900"><AlertTriangle size={13} /> {flag.title}</p>
      <p className="mt-0.5 text-ink-muted"><span className="font-medium text-ink">AI reason:</span> {flag.reason}</p>
    </div>
  );
}

function OtherFlags({ flags, interactionId, exclude }: { flags: FlagMarker[]; interactionId: string; exclude?: string }) {
  const list = flags.filter((f) => f.id !== exclude);
  if (!list.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {list.map((f) => (
        <Link key={f.id} href={`/inbox/${interactionId}?flag=${f.id}#evidence`} scroll={false}
          className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-2xs text-amber-900 ring-1 ring-inset ring-amber-200 hover:bg-amber-100">
          <AlertTriangle size={11} /> {f.title}
        </Link>
      ))}
    </div>
  );
}

function Attachments({ items }: { items: AttachmentRow[] }) {
  if (!items.length) return null;
  return (
    <ul className="mt-1.5 space-y-0.5">
      {items.map((a) => (
        <li key={a.id} className="flex items-center gap-1 text-2xs text-ink-muted">
          <Paperclip size={11} /> {a.file_name ?? 'Attachment'}{a.mime_type ? ` · ${a.mime_type}` : ''}{a.size_bytes ? ` · ${Math.round(a.size_bytes / 1024)} KB` : ''}
        </li>
      ))}
    </ul>
  );
}

/** Chat / WhatsApp thread: customer left, agent right, response-delay chips between a customer turn and the next agent reply. */
export function ChatThread({ messages, interactionId, targetSeq, selectedFlag, markers, slaMinutes, focusLabel }: {
  messages: ThreadMessage[]; interactionId: string; targetSeq: number | null; selectedFlag: FlagMarker | null;
  markers: Record<number, FlagMarker[]>; slaMinutes: number; focusLabel: string | null;
}) {
  const { delays, awaitingReply } = replyDelays(messages);
  return (
    <ol className="space-y-3 px-4 py-4" aria-label="Conversation thread">
      {messages.map((m) => {
        const delay = delays.get(m.seq) ?? null;
        const isAgent = m.sender_type === 'agent';
        const isSystem = m.sender_type === 'system' || m.sender_type === 'bot';
        const isTarget = m.seq === targetSeq;
        const flags = markers[m.seq] ?? [];
        const overSla = delay !== null && delay > slaMinutes * 60;
        return (
          <li key={m.seq}>
            {delay !== null && (
              <div className="mb-2 flex justify-center">
                <span className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs ring-1 ring-inset',
                  overSla ? 'bg-amber-50 text-amber-900 ring-amber-200' : 'bg-stone-50 text-ink-muted ring-line')}
                  title={overSla ? `Above the ${slaMinutes}-minute first-response SLA (raw clock time; business hours not excluded)` : `Within the ${slaMinutes}-minute SLA`}>
                  <Clock size={11} /> Agent replied after {fmtDuration(delay)}{overSla ? ` · over ${slaMinutes}m SLA` : ''}
                </span>
              </div>
            )}
            <div className={clsx('flex', isAgent ? 'justify-end' : isSystem ? 'justify-center' : 'justify-start')}>
              <div id={isTarget ? 'evidence' : `msg-${m.seq}`} tabIndex={isTarget ? -1 : undefined}
                className={clsx('max-w-[85%] rounded-2xl px-3.5 py-2.5 outline-none sm:max-w-[75%]',
                  isAgent ? 'rounded-br-md bg-brand-100 text-ink' : isSystem ? 'bg-stone-100 text-ink-muted' : 'rounded-bl-md border border-line bg-white text-ink',
                  isTarget && clsx('ring-2 ring-offset-2', SEV_RING[selectedFlag?.severity ?? 'medium']))}>
                <p className="mb-0.5 flex items-center gap-2 text-2xs text-ink-muted">
                  <span className={clsx('font-semibold', isAgent ? 'text-brand' : 'text-sky-800')}>{isAgent ? m.sender_name ?? 'Agent' : isSystem ? 'System' : 'Customer'}</span>
                  <time dateTime={m.sent_at} title={fmtDateTime(m.sent_at)}>{fmtTime(m.sent_at)}</time>
                </p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.body}</p>
                <Attachments items={m.attachments} />
                {isTarget && selectedFlag && <FlagNote flag={selectedFlag} />}
                {isTarget && !selectedFlag && focusLabel && <p className="mt-1 text-2xs font-medium text-brand">{focusLabel}</p>}
                <OtherFlags flags={flags} interactionId={interactionId} exclude={isTarget ? selectedFlag?.id : undefined} />
              </div>
            </div>
          </li>
        );
      })}
      {awaitingReply && (
        <li className="flex justify-center"><span className="rounded-full bg-stone-50 px-2 py-0.5 text-2xs text-ink-muted ring-1 ring-inset ring-line">Last customer message has no agent reply yet</span></li>
      )}
      {!messages.length && <li className="py-6 text-center text-sm text-ink-muted">No messages were imported for this conversation.</li>}
    </ol>
  );
}

export function EmailThread({ emails, interactionId, targetSeq, selectedFlag, markers, focusLabel }: {
  emails: EmailMessage[]; interactionId: string; targetSeq: number | null; selectedFlag: FlagMarker | null;
  markers: Record<number, FlagMarker[]>; focusLabel: string | null;
}) {
  return (
    <ol className="divide-y divide-line" aria-label="Email thread">
      {emails.map((e) => {
        const isTarget = e.seq === targetSeq;
        const isAgent = e.sender_type === 'agent';
        return (
          <li key={e.seq} id={isTarget ? 'evidence' : `msg-${e.seq}`} tabIndex={isTarget ? -1 : undefined}
            className={clsx('px-4 py-3 outline-none', isTarget && clsx('ring-2 ring-inset bg-amber-50/30', SEV_RING[selectedFlag?.severity ?? 'medium']))}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-medium text-ink">{e.subject ?? '(no subject)'}</p>
              <time className="text-2xs text-ink-muted" dateTime={e.sent_at}>{fmtDateTime(e.sent_at)}</time>
            </div>
            <dl className="mt-1 grid grid-cols-[3rem_1fr] gap-x-2 text-2xs text-ink-muted">
              <dt>From</dt><dd className="break-all"><span className={clsx('font-medium', isAgent ? 'text-brand' : 'text-sky-800')}>{isAgent ? 'Agent' : e.sender_type === 'customer' ? 'Customer' : 'System'}</span> · {e.from_address}</dd>
              <dt>To</dt><dd className="break-all">{e.to_addresses.join(', ') || '—'}</dd>
              {e.cc_addresses.length > 0 && <><dt>Cc</dt><dd className="break-all">{e.cc_addresses.join(', ')}</dd></>}
            </dl>
            <div className={clsx('mt-2 whitespace-pre-wrap rounded-lg px-3 py-2.5 text-sm leading-relaxed text-ink', isAgent ? 'bg-brand-50' : 'border border-line bg-white')}>{e.body_text}</div>
            <Attachments items={e.attachments} />
            {isTarget && selectedFlag && <FlagNote flag={selectedFlag} />}
            {isTarget && !selectedFlag && focusLabel && <p className="mt-1 text-2xs font-medium text-brand">{focusLabel}</p>}
            <OtherFlags flags={markers[e.seq] ?? []} interactionId={interactionId} exclude={isTarget ? selectedFlag?.id : undefined} />
          </li>
        );
      })}
      {!emails.length && <li className="px-4 py-6 text-center text-sm text-ink-muted">No email messages were imported for this thread.</li>}
    </ol>
  );
}

/** Seconds from the first unanswered customer message to the next agent reply, keyed by the agent message seq. */
function replyDelays(messages: { seq: number; sender_type: string; sent_at: string }[]): { delays: Map<number, number>; awaitingReply: boolean } {
  const out = new Map<number, number>();
  let waitingSince: number | null = null;
  for (const m of messages) {
    const t = new Date(m.sent_at).getTime();
    if (m.sender_type === 'customer') { if (waitingSince === null) waitingSince = t; }
    else if (m.sender_type === 'agent' && waitingSince !== null) { out.set(m.seq, (t - waitingSince) / 1000); waitingSince = null; }
  }
  return { delays: out, awaitingReply: waitingSince !== null };
}
