'use client';
import { useEffect, useState } from 'react';
import { ActionForm, SubmitButton } from './ActionForm';
import { BULK_FORM_ID, type FormAction } from './types';

/** Bulk start-review / assign bar. Row checkboxes live in the server-rendered table and join this form via form="bulk-flags". */
export function BulkFlagBar({ action, reviewers, canReview, canAssign }: {
  action: FormAction; reviewers: { id: string; name: string }[]; canReview: boolean; canAssign: boolean;
}) {
  const [count, setCount] = useState(0);
  const [act, setAct] = useState(canReview ? 'start_review' : 'assign');
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setCount(document.querySelectorAll<HTMLInputElement>(`input[form="${BULK_FORM_ID}"][name="ids"]:checked`).length);
    update();
    document.addEventListener('change', update);
    return () => document.removeEventListener('change', update);
  }, []);
  const toggleAll = (on: boolean) => {
    document.querySelectorAll<HTMLInputElement>(`input[form="${BULK_FORM_ID}"][name="ids"]`).forEach((el) => { el.checked = on; });
    setCount(on ? document.querySelectorAll(`input[form="${BULK_FORM_ID}"][name="ids"]`).length : 0);
  };
  if (!canReview && !canAssign) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-canvas/60 px-4 py-2">
      <label className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
        <input type="checkbox" onChange={(e) => toggleAll(e.target.checked)} className="accent-[#784900]" aria-label="Select all alerts on this page" /> Select page
      </label>
      <span className="text-xs text-ink-muted" aria-live="polite">{count} selected</span>
      <ActionForm id={BULK_FORM_ID} action={action} className="flex flex-wrap items-center gap-2" onSuccess={(m) => { toggleAll(false); setNotice(m ?? 'Done.'); }}>
        <select name="action" value={act} onChange={(e) => setAct(e.target.value)} className="input h-8 w-auto py-0 text-xs" aria-label="Bulk action">
          {canReview && <option value="start_review">Start review</option>}
          {canAssign && <option value="assign">Assign reviewer</option>}
        </select>
        {act === 'assign' && (
          <select name="assigneeId" required className="input h-8 w-auto py-0 text-xs" aria-label="Reviewer" defaultValue="">
            <option value="" disabled>Choose reviewer…</option>
            {reviewers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
        <SubmitButton variant="primary" disabled={count === 0}>Apply to selected</SubmitButton>
      </ActionForm>
      {notice && <p role="status" className="text-2xs text-emerald-700">{notice}</p>}
    </div>
  );
}
