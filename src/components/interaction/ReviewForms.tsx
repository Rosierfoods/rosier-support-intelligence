'use client';
import { useState } from 'react';
import { buttonClass } from '@/components/ui';
import { ActionForm, SubmitButton } from './ActionForm';
import type { FormAction } from './types';

const GROUP_LABELS: Record<string, string> = {
  communication: 'Communication & empathy', understanding: 'Problem understanding', accuracy: 'Information accuracy',
  policy: 'Policy compliance', resolution: 'Resolution & ownership', closure: 'Closure & clarity',
};

export interface CorrectionCriterion { code: string; name: string; description: string; group: string; current: number | null; currentNa: boolean; evidence?: string }

/** Manual QA assessment: override criterion scores (0–5 or N/A) with notes → new human evaluation. */
export function CorrectionForm({ action, interactionId, criteria, hasEvaluation }: {
  action: FormAction; interactionId: string; criteria: CorrectionCriterion[]; hasEvaluation: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  if (!open) {
    return (
      <div className="space-y-1.5">
        {notice && <p role="status" className="text-xs text-emerald-700">{notice}</p>}
        <button type="button" onClick={() => { setOpen(true); setNotice(null); }} className={buttonClass('secondary', 'sm')}>
          {hasEvaluation ? 'Correct scores…' : 'Add manual QA assessment…'}
        </button>
      </div>
    );
  }
  const groups = Array.from(new Set(criteria.map((c) => c.group)));
  return (
    <ActionForm action={action} hidden={{ interactionId }} onSuccess={(m) => { setOpen(false); setNotice(m ?? 'Saved.'); }} className="space-y-3 rounded-lg border border-brand-500/30 bg-brand-50/40 p-3">
      <p className="text-xs text-ink-muted">Score each criterion 0–5, or N/A when it does not apply (N/A never lowers the score). Saving creates a new <span className="font-medium text-ink">human</span> evaluation; the AI evaluation is kept in history.</p>
      {groups.map((g) => (
        <fieldset key={g} className="space-y-1.5">
          <legend className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">{GROUP_LABELS[g] ?? g}</legend>
          {criteria.filter((c) => c.group === g).map((c) => (
            <div key={c.code} className="grid grid-cols-[1fr_auto] items-start gap-2">
              <div className="min-w-0">
                <label htmlFor={`score-${c.code}`} className="text-xs font-medium text-ink" title={c.description}>{c.name}</label>
                <input name={`note:${c.code}`} placeholder="Criterion note (optional)" aria-label={`Note for ${c.name}`}
                  className="input mt-0.5 h-7 px-2 text-2xs" />
              </div>
              <select id={`score-${c.code}`} name={`score:${c.code}`} defaultValue={c.currentNa ? 'na' : c.current === null ? '' : String(c.current)}
                className="input h-8 w-20 py-0 text-xs">
                <option value="">—</option>
                <option value="na">N/A</option>
                {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          ))}
        </fieldset>
      ))}
      <label className="block">
        <span className="label">Reviewer notes (required)</span>
        <textarea name="notes" required minLength={5} rows={3} className="input h-auto py-1.5 text-xs" placeholder="What did you change and why? Reference the evidence." />
      </label>
      <div className="flex gap-2">
        <SubmitButton variant="primary">Save human assessment</SubmitButton>
        <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>Cancel</button>
      </div>
    </ActionForm>
  );
}

/** Add an issue label with category → subcategory dependent selects. */
export function AddLabelForm({ action, interactionId, categories, products }: {
  action: FormAction; interactionId: string;
  categories: { id: string; code: string; name: string; parent_code: string | null }[]; products: string[];
}) {
  const [open, setOpen] = useState(false);
  const [cat, setCat] = useState('');
  const parents = categories.filter((c) => !c.parent_code);
  const parentCode = parents.find((p) => p.id === cat)?.code;
  const subs = categories.filter((c) => c.parent_code && c.parent_code === parentCode);
  if (!open) return <button type="button" onClick={() => setOpen(true)} className={buttonClass('secondary', 'sm')}>Add label…</button>;
  return (
    <ActionForm action={action} hidden={{ interactionId }} onSuccess={() => { setOpen(false); setCat(''); }} resetOnSuccess className="space-y-2 rounded-lg border border-line bg-canvas/60 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block"><span className="label">Category</span>
          <select name="categoryId" required value={cat} onChange={(e) => setCat(e.target.value)} className="input h-8 py-0 text-xs">
            <option value="">Choose…</option>
            {parents.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="block"><span className="label">Subcategory</span>
          <select name="subcategoryId" disabled={!subs.length} className="input h-8 py-0 text-xs" key={cat}>
            <option value="">None</option>
            {subs.map((sc) => <option key={sc.id} value={sc.id}>{sc.name}</option>)}
          </select>
        </label>
        <label className="block"><span className="label">Product</span>
          <select name="product" className="input h-8 py-0 text-xs">
            <option value="">—</option>
            {products.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="block"><span className="label">Severity</span>
          <select name="severity" className="input h-8 py-0 text-xs">
            <option value="">—</option>
            {['critical', 'high', 'medium', 'low'].map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
          </select>
        </label>
      </div>
      <label className="block"><span className="label">Customer reason (optional)</span>
        <input name="customerReason" className="input h-8 text-xs" maxLength={1000} />
      </label>
      <label className="block"><span className="label">Reviewer note (optional)</span>
        <input name="note" className="input h-8 text-xs" maxLength={1000} />
      </label>
      <div className="flex gap-2">
        <SubmitButton variant="primary">Add label</SubmitButton>
        <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>Cancel</button>
      </div>
    </ActionForm>
  );
}

/** Small toggled form: a button that reveals a note field before submitting (remove label, reject root cause…). */
export function NoteAction({ action, hidden, label, submitLabel, placeholder, required, variant = 'ghost' }: {
  action: FormAction; hidden: Record<string, string>; label: string; submitLabel: string; placeholder?: string; required?: boolean;
  variant?: 'secondary' | 'ghost';
}) {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" onClick={() => setOpen(true)} className={buttonClass(variant, 'sm', 'h-7 px-2')}>{label}</button>;
  return (
    <ActionForm action={action} hidden={hidden} onSuccess={() => setOpen(false)} className="mt-1 flex w-full flex-wrap items-center gap-1.5">
      <input name="note" required={required} placeholder={placeholder ?? (required ? 'Note (required)' : 'Note (optional)')} aria-label="Note"
        className="input h-7 min-w-[10rem] flex-1 px-2 text-2xs" maxLength={1000} />
      <SubmitButton variant="primary" className="h-7">{submitLabel}</SubmitButton>
      <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm', 'h-7 px-2')}>Cancel</button>
    </ActionForm>
  );
}
