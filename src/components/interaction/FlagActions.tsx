'use client';
import { useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import clsx from 'clsx';
import { MoreHorizontal } from 'lucide-react';
import { buttonClass } from '@/components/ui';
import { ActionForm, SubmitButton } from './ActionForm';
import type { FormAction } from './types';

export interface FlagActionsProps {
  flag: { id: string; status: string; escalated: boolean; assigned_to: string | null };
  action: FormAction;
  canReview: boolean;
  canAssign: boolean;
  canCoach: boolean;
  reviewers: { id: string; name: string }[];
  /** compact = collapsible menu for table rows */
  compact?: boolean;
}

function QuickButton({ act, label, primary, inputRef }: { act: string; label: string; primary?: boolean; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} onClick={() => { if (inputRef.current) inputRef.current.value = act; }}
      className={buttonClass(primary ? 'primary' : 'secondary', 'sm')}>{label}</button>
  );
}

function Panel({ flag, action, canReview, canAssign, canCoach, reviewers }: FlagActionsProps) {
  const [mode, setMode] = useState<null | 'fp' | 'assign' | 'escalate'>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const actRef = useRef<HTMLInputElement>(null);
  const done = (m?: string) => { setNotice(m ?? 'Saved.'); setMode(null); };
  const st = flag.status;
  const can = {
    start: canReview && st === 'new',
    confirm: canReview && (st === 'new' || st === 'under_review'),
    fp: canReview && ['new', 'under_review', 'confirmed'].includes(st),
    reopen: canReview && (st === 'false_positive' || st === 'resolved'),
    resolve: canAssign && ['new', 'under_review', 'confirmed', 'coaching_assigned'].includes(st),
    escalate: canAssign && !flag.escalated && !['false_positive', 'resolved'].includes(st),
    assign: canAssign && !['false_positive', 'resolved'].includes(st),
    coach: canCoach && st === 'confirmed',
  };
  const none = !Object.values(can).some(Boolean);
  const noticeEl = notice && <p role="status" className="text-2xs text-emerald-700">{notice}</p>;
  if (none) return <>{noticeEl}<p className="text-2xs text-ink-faint">No further actions available for this status with your role.</p></>;
  return (
    <div className="space-y-2">
      {noticeEl}
      <ActionForm action={action} hidden={{ flagId: flag.id }} onSuccess={done} className="flex flex-wrap gap-1.5">
        <input ref={actRef} type="hidden" name="action" defaultValue="" />
        {can.start && <QuickButton inputRef={actRef} act="start_review" label="Start review" primary />}
        {can.confirm && <QuickButton inputRef={actRef} act="confirm" label="Confirm" primary={!can.start} />}
        {can.fp && <button type="button" onClick={() => setMode(mode === 'fp' ? null : 'fp')} aria-expanded={mode === 'fp'} className={buttonClass('secondary', 'sm')}>False positive…</button>}
        {can.reopen && <QuickButton inputRef={actRef} act="reopen" label="Reopen" />}
        {can.assign && <button type="button" onClick={() => setMode(mode === 'assign' ? null : 'assign')} aria-expanded={mode === 'assign'} className={buttonClass('secondary', 'sm')}>Assign…</button>}
        {can.escalate && <button type="button" onClick={() => setMode(mode === 'escalate' ? null : 'escalate')} aria-expanded={mode === 'escalate'} className={buttonClass('secondary', 'sm')}>Escalate…</button>}
        {can.resolve && <QuickButton inputRef={actRef} act="resolve" label="Resolve" />}
        {can.coach && <Link href={`/coaching/new?flag=${flag.id}`} className={buttonClass('ghost', 'sm')}>Assign coaching →</Link>}
      </ActionForm>
      {mode === 'fp' && (
        <ActionForm action={action} hidden={{ flagId: flag.id, action: 'false_positive' }} onSuccess={done} className="space-y-1.5">
          <label className="block">
            <span className="label">Why is this a false positive? (required)</span>
            <textarea name="note" required minLength={3} rows={2} className="input h-auto py-1.5 text-xs" placeholder="e.g. Agent quoted the approved 7-day replacement window correctly." />
          </label>
          <SubmitButton variant="primary">Mark false positive</SubmitButton>
        </ActionForm>
      )}
      {mode === 'assign' && (
        <ActionForm action={action} hidden={{ flagId: flag.id, action: 'assign' }} onSuccess={done} className="flex flex-wrap items-end gap-1.5">
          <label className="block min-w-[10rem] flex-1">
            <span className="label">Reviewer</span>
            <select name="assigneeId" required defaultValue={flag.assigned_to ?? ''} className="input h-8 py-0 text-xs">
              <option value="" disabled>Choose reviewer…</option>
              {reviewers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <SubmitButton variant="primary">Assign</SubmitButton>
        </ActionForm>
      )}
      {mode === 'escalate' && (
        <ActionForm action={action} hidden={{ flagId: flag.id, action: 'escalate' }} onSuccess={done} className="space-y-1.5">
          <label className="block">
            <span className="label">Escalation note (optional) — CRM managers and admins are notified</span>
            <textarea name="note" rows={2} className="input h-auto py-1.5 text-xs" />
          </label>
          <SubmitButton variant="primary">Escalate</SubmitButton>
        </ActionForm>
      )}
    </div>
  );
}

export function FlagActions(props: FlagActionsProps) {
  if (!props.compact) return <Panel {...props} />;
  return (
    <details className="group relative">
      <summary className={clsx(buttonClass('secondary', 'sm'), 'cursor-pointer list-none [&::-webkit-details-marker]:hidden')} aria-label="Alert actions">
        <MoreHorizontal size={14} /> Actions
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-[22rem] max-w-[85vw] rounded-xl border border-line bg-white p-3 shadow-lg">
        <Panel {...props} />
      </div>
    </details>
  );
}
