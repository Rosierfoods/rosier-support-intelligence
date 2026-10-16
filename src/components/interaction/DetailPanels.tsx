import Link from 'next/link';
import clsx from 'clsx';
import { Sparkles, AlertTriangle, ShieldCheck, ExternalLink } from 'lucide-react';
import type { InteractionDetail, EvaluationRow, FlagRow } from '@/lib/repos/interactions';
import { Badge, Card, CardBody, CardHeader, DemoBadge, Notice, SectionTitle } from '@/components/ui';
import { FlagStatusBadge, ReviewBadge, ScoreBadge, SentimentBadge, SeverityBadge } from '@/components/badges';
import { fmtDateTime, fmtINR, fmtMs, fmtPct, relTime, titleCase } from '@/lib/format';
import { RESOLUTION_STATUSES, REVIEW_STATUSES, RUBRIC_GROUP_LABELS, type RubricGroup } from '@/lib/constants';
import { ActionForm, SubmitButton } from './ActionForm';
import { FlagActions } from './FlagActions';
import { AddLabelForm, CorrectionForm, NoteAction, type CorrectionCriterion } from './ReviewForms';
import type { FormAction } from './types';

function AiTag({ children }: { children?: React.ReactNode }) {
  return <Badge tone="info" className="gap-1"><Sparkles size={11} />{children ?? 'AI-generated'}</Badge>;
}

function List({ items, empty, tone }: { items: unknown[]; empty?: string; tone?: 'bad' | 'good' | 'warn' }) {
  const list = (items ?? []).map((x) => (typeof x === 'string' ? x : (x as any)?.text ?? (x as any)?.statement ?? JSON.stringify(x))).filter(Boolean);
  if (!list.length) return empty ? <p className="text-xs text-ink-faint">{empty}</p> : null;
  return (
    <ul className={clsx('ml-4 list-disc space-y-0.5 text-[13px]', tone === 'bad' ? 'marker:text-red-500' : tone === 'good' ? 'marker:text-emerald-600' : tone === 'warn' ? 'marker:text-amber-500' : 'marker:text-ink-faint')}>
      {list.map((t, i) => <li key={i}>{t}</li>)}
    </ul>
  );
}

// ───────────────────────── AI insights ─────────────────────────
export function AiInsightsCard({ d }: { d: InteractionDetail }) {
  const out = d.analysis?.output ?? {};
  const summary = out.summary ?? d.interaction.ai_summary;
  const intent = out.customer_intent ?? d.interaction.customer_intent;
  const questions: string[] = out.customer_questions ?? [];
  const actions: string[] = out.requested_actions ?? [];
  const concerns: string[] = out.concerns ?? out.objections ?? [];
  return (
    <Card className="border-sky-200/80">
      <CardHeader title={<span className="flex items-center gap-2">AI summary <AiTag /></span>}
        subtitle={d.analysis ? `${d.analysis.provider} · ${d.analysis.model} · prompt ${d.analysis.prompt_version} · ${relTime(d.analysis.created_at)}` : 'No AI analysis stored yet'} />
      <CardBody className="space-y-3 bg-sky-50/30">
        {d.analysis?.status === 'failed' && <Notice tone="bad" title="AI analysis failed">{d.analysis.error ?? 'Unknown error'}</Notice>}
        {summary ? <p className="text-sm leading-relaxed text-ink">{summary}</p> : <p className="text-sm text-ink-muted">No summary available.</p>}
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
          <div className="col-span-2"><dt className="text-2xs font-medium uppercase tracking-wide text-ink-faint">Customer intent</dt><dd className="mt-0.5">{intent ?? '—'}</dd></div>
          <div><dt className="text-2xs font-medium uppercase tracking-wide text-ink-faint">Sentiment</dt><dd className="mt-0.5"><SentimentBadge sentiment={out.sentiment ?? d.interaction.sentiment} /></dd></div>
          <div><dt className="text-2xs font-medium uppercase tracking-wide text-ink-faint">Product</dt><dd className="mt-0.5">{out.product ?? d.interaction.product ?? '—'}</dd></div>
          {out.language && <div><dt className="text-2xs font-medium uppercase tracking-wide text-ink-faint">Language</dt><dd className="mt-0.5">{out.language}</dd></div>}
        </dl>
        {questions.length > 0 && <div><SectionTitle>Customer questions</SectionTitle><List items={questions} /></div>}
        {actions.length > 0 && <div><SectionTitle>Requested actions</SectionTitle><List items={actions} /></div>}
        {concerns.length > 0 && <div><SectionTitle>Detected concerns</SectionTitle><List items={concerns} tone="warn" /></div>}
        <p className="text-2xs text-ink-faint">AI interpretation of the source conversation — verify against the original content before acting.</p>
      </CardBody>
    </Card>
  );
}

// ───────────────────────── Quality evaluation ─────────────────────────
function Evaluator({ e }: { e: EvaluationRow }) {
  return e.evaluator_type === 'human'
    ? <span className="inline-flex items-center gap-1"><ShieldCheck size={12} className="text-emerald-700" /> Human review · {e.evaluator_name ?? 'Reviewer'}</span>
    : <span className="inline-flex items-center gap-1"><Sparkles size={12} className="text-sky-700" /> AI · {e.provider ?? 'provider'} / {e.model ?? 'model'}</span>;
}

export function QualityCard({ d, canCorrect, correctAction }: { d: InteractionDetail; canCorrect: boolean; correctAction: FormAction }) {
  const current = d.evaluations.find((e) => e.is_current) ?? null;
  const history = d.evaluations.filter((e) => e !== current);
  const crit = new Map(d.criteria.map((c) => [c.code, c]));
  const kb = new Map(d.kbVersions.map((k) => [k.id, k]));
  const channel = d.interaction.channel as string;
  const formCriteria: CorrectionCriterion[] = d.criteria.filter((c) => c.is_active && c.channels.includes(channel)).map((c) => {
    const cs = current?.criterion_scores.find((x) => x.code === c.code);
    return { code: c.code, name: c.name, description: c.description, group: c.group_code, current: cs?.score ?? null, currentNa: !!cs?.na, evidence: cs?.evidence };
  });
  return (
    <Card id="quality">
      <CardHeader title={<span className="flex items-center gap-2">Quality evaluation {current?.evaluator_type === 'ai' && <AiTag>AI score</AiTag>}{current?.evaluator_type === 'human' && <Badge tone="good">Human reviewed</Badge>}</span>}
        subtitle={current ? <><Evaluator e={current} /> · {fmtDateTime(current.created_at)}</> : 'Not evaluated yet'}
        actions={<ReviewBadge status={d.interaction.review_status} />} />
      <CardBody className="space-y-4">
        {current ? (
          <>
            <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
              <div>
                <p className="text-2xs font-medium uppercase tracking-wide text-ink-faint">Overall</p>
                <p className="text-3xl font-semibold tabular-nums tracking-tight text-ink">{current.overall_score === null ? '—' : Math.round(Number(current.overall_score))}<span className="text-base text-ink-faint">/100</span></p>
              </div>
              <div><p className="text-2xs font-medium uppercase tracking-wide text-ink-faint">Band</p><p className="mt-1"><ScoreBadge score={current.overall_score} band={current.band} /> <span className="text-sm">{current.band ?? '—'}</span></p></div>
              <div><p className="text-2xs font-medium uppercase tracking-wide text-ink-faint">Confidence</p><p className="mt-1 text-sm tabular-nums">{current.confidence === null ? (current.evaluator_type === 'human' ? 'Human' : '—') : fmtPct(Number(current.confidence), 0)}</p></div>
            </div>
            {current.policy_uncertain && (
              <Notice tone="warn" title="Policy uncertain">{current.policy_uncertainty_note ?? 'The evaluator could not find an approved policy covering part of this conversation. Treat policy-related scores with caution.'}</Notice>
            )}
            {current.notes && <Notice tone="info" title="Reviewer notes">{current.notes}</Notice>}

            <div>
              <SectionTitle>Criterion scores (0–5)</SectionTitle>
              <div className="overflow-x-auto scrollbar-thin rounded-lg border border-line">
                <table className="min-w-full divide-y divide-line text-[13px]">
                  <thead className="bg-canvas/60"><tr><th className="th">Criterion</th><th className="th">Score</th><th className="th">Evidence / rationale</th></tr></thead>
                  <tbody className="divide-y divide-line">
                    {current.criterion_scores.map((c) => {
                      const def = crit.get(c.code);
                      const n = c.na || c.score === null ? null : Number(c.score);
                      return (
                        <tr key={c.code}>
                          <td className="px-3 py-2 align-top"><p className="font-medium text-ink">{def?.name ?? c.code}</p><p className="text-2xs text-ink-faint">{def ? RUBRIC_GROUP_LABELS[def.group_code as RubricGroup] ?? def.group_code : ''}</p></td>
                          <td className="whitespace-nowrap px-3 py-2 align-top">
                            {n === null ? <Badge tone="muted">N/A</Badge> : <Badge tone={n >= 4 ? 'good' : n >= 3 ? 'warn' : 'bad'}><span className="tabular-nums">{n}/5</span></Badge>}
                          </td>
                          <td className="px-3 py-2 align-top text-ink-muted">
                            {c.evidence && <p className="text-ink">“{c.evidence}”</p>}
                            {c.rationale && <p className="mt-0.5">{c.rationale}</p>}
                            {c.reviewer_note && <p className="mt-0.5 text-emerald-800">Reviewer: {c.reviewer_note}</p>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <SectionTitle>Group scores (points earned / weight)</SectionTitle>
              <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {Object.entries(current.group_scores ?? {}).map(([g, v]) => (
                  <li key={g} className="flex items-center justify-between gap-2 rounded-lg bg-canvas px-2.5 py-1.5 text-xs">
                    <span className="text-ink-muted">{RUBRIC_GROUP_LABELS[g as RubricGroup] ?? g}</span>
                    <span className="tabular-nums font-medium text-ink">{v.applicable && v.score !== null ? `${Number(v.score).toFixed(1)} / ${v.weight}` : 'N/A'}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div><SectionTitle>Positive behaviours</SectionTitle><List items={current.positives} empty="None recorded" tone="good" /></div>
              <div><SectionTitle>Missed opportunities</SectionTitle><List items={current.missed_opportunities} empty="None recorded" tone="warn" /></div>
              <div><SectionTitle>Incorrect statements</SectionTitle><List items={current.incorrect_statements} empty="None recorded" tone="bad" /></div>
              <div><SectionTitle>Policy violations</SectionTitle><List items={current.policy_violations} empty="None recorded" tone="bad" /></div>
              <div className="sm:col-span-2"><SectionTitle>Customer frustration indicators</SectionTitle><List items={current.frustration_indicators} empty="None recorded" tone="warn" /></div>
            </div>

            {current.improved_response && (
              <div>
                <SectionTitle>Recommended improved response</SectionTitle>
                <blockquote className="rounded-lg border border-sky-200 bg-sky-50/50 px-3 py-2 text-[13px] leading-relaxed text-ink">{current.improved_response}</blockquote>
                <p className="mt-1 text-2xs text-ink-faint">AI-suggested wording — adapt to the approved templates.</p>
              </div>
            )}

            <div>
              <SectionTitle>Policy versions used</SectionTitle>
              {current.kb_version_ids?.length ? (
                <ul className="space-y-1 text-[13px]">
                  {current.kb_version_ids.map((vid) => {
                    const k = kb.get(vid);
                    return (
                      <li key={vid} className="flex flex-wrap items-center gap-1.5">
                        {k ? <Link href={`/knowledge-base/${k.article_id}`} className="link">{k.title}</Link> : <span className="text-ink-faint">Unknown version</span>}
                        {k && <span className="text-2xs text-ink-muted">v{k.version}</span>}
                        {k?.is_placeholder && <Badge tone="warn" title="Template text — not an approved Rosier policy">Placeholder policy</Badge>}
                      </li>
                    );
                  })}
                </ul>
              ) : <p className="text-xs text-ink-faint">No knowledge-base articles were referenced.</p>}
            </div>
          </>
        ) : (
          <p className="text-sm text-ink-muted">{d.interaction.processing_status === 'completed' ? 'This interaction was not eligible for AI evaluation (e.g. missed call).' : 'The evaluation will appear once AI analysis completes.'}</p>
        )}

        {canCorrect && <div className="border-t border-line pt-3"><CorrectionForm action={correctAction} interactionId={d.interaction.id} criteria={formCriteria} hasEvaluation={!!current} /></div>}

        {history.length > 0 && (
          <details className="rounded-lg border border-line">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink-muted hover:text-ink">Previous evaluations ({history.length})</summary>
            <ul className="divide-y divide-line">
              {history.map((e) => (
                <li key={e.id} className="px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <ScoreBadge score={e.overall_score} band={e.band} /><span>{e.band ?? '—'}</span>
                    <span className="text-ink-muted"><Evaluator e={e} /> · {fmtDateTime(e.created_at)}</span>
                  </div>
                  {e.notes && <p className="mt-1 text-ink-muted">{e.notes}</p>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardBody>
    </Card>
  );
}

// ───────────────────────── Issue labels ─────────────────────────
export function LabelsCard({ d, canCorrect, products, categories, actions }: {
  d: InteractionDetail; canCorrect: boolean; products: string[];
  categories: { id: string; code: string; name: string; parent_code: string | null }[];
  actions: { add: FormAction; remove: FormAction; rootCause: FormAction };
}) {
  const active = d.labels.filter((l) => l.is_active);
  const removed = d.labels.filter((l) => !l.is_active);
  const iid = d.interaction.id;
  return (
    <Card>
      <CardHeader title="Customer issues" subtitle={`${active.length} active label${active.length === 1 ? '' : 's'} · AI labels can be corrected by reviewers`} />
      <CardBody className="space-y-3">
        {active.map((l) => (
          <div key={l.id} className="rounded-lg border border-line p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{l.category_name}{l.subcategory_name && <span className="text-ink-muted"> › {l.subcategory_name}</span>}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {l.is_primary && <Badge tone="brand">Primary</Badge>}
                  {l.severity && <SeverityBadge severity={l.severity} />}
                  {l.source === 'ai' ? <AiTag>AI label{l.confidence ? ` · ${fmtPct(Number(l.confidence), 0)}` : ''}</AiTag> : <Badge tone="good">Human · {l.created_by_name ?? 'reviewer'}</Badge>}
                  {l.escalated && <Badge tone="warn">Escalated</Badge>}
                </div>
              </div>
              {canCorrect && <NoteAction action={actions.remove} hidden={{ interactionId: iid, labelId: l.id }} label="Remove" submitLabel="Remove label" />}
            </div>
            <dl className="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-2">
              {l.product && <div><dt className="inline text-ink-faint">Product: </dt><dd className="inline">{l.product}{l.variant ? ` (${l.variant})` : ''}</dd></div>}
              {l.order_ref && <div><dt className="inline text-ink-faint">Order: </dt><dd className="inline">{l.order_ref}</dd></div>}
              {l.customer_reason && <div className="sm:col-span-2"><dt className="inline text-ink-faint">Customer reason: </dt><dd className="inline">{l.customer_reason}</dd></div>}
              {l.resolution_requested && <div><dt className="inline text-ink-faint">Requested: </dt><dd className="inline">{l.resolution_requested}</dd></div>}
              {l.resolution_provided && <div><dt className="inline text-ink-faint">Provided: </dt><dd className="inline">{l.resolution_provided}</dd></div>}
              {l.replacement_status && <div><dt className="inline text-ink-faint">Replacement: </dt><dd className="inline">{titleCase(l.replacement_status)}</dd></div>}
              {l.refund_amount_source && l.refund_amount !== null && <div><dt className="inline text-ink-faint">Refund: </dt><dd className="inline">{fmtINR(l.refund_amount)} <span className="text-ink-faint">(source: {l.refund_amount_source})</span></dd></div>}
            </dl>
            {l.evidence && <p className="mt-1.5 border-l-2 border-line pl-2 text-xs italic text-ink-muted">“{l.evidence}”</p>}
            {l.root_causes.length > 0 && (
              <div className="mt-2 space-y-1.5">
                <p className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">Root causes</p>
                {l.root_causes.map((rc) => (
                  <div key={rc.id} className="rounded-md bg-canvas px-2.5 py-1.5 text-xs">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {rc.status === 'suspected' ? <Badge tone="info" title="Inferred by AI — not verified">AI inference · suspected</Badge>
                        : rc.status === 'confirmed' ? <Badge tone="good">Confirmed{rc.confirmed_by_name ? ` · ${rc.confirmed_by_name}` : ''}</Badge>
                          : <Badge tone="muted">Rejected{rc.confirmed_by_name ? ` · ${rc.confirmed_by_name}` : ''}</Badge>}
                      <span className="text-ink">{rc.cause}</span>
                    </div>
                    {canCorrect && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {rc.status !== 'confirmed' && <NoteAction action={actions.rootCause} hidden={{ interactionId: iid, rootCauseId: rc.id, status: 'confirmed' }} label="Confirm" submitLabel="Confirm cause" />}
                        {rc.status !== 'rejected' && <NoteAction action={actions.rootCause} hidden={{ interactionId: iid, rootCauseId: rc.id, status: 'rejected' }} label="Reject" submitLabel="Reject cause" />}
                        {rc.status !== 'suspected' && <NoteAction action={actions.rootCause} hidden={{ interactionId: iid, rootCauseId: rc.id, status: 'suspected' }} label="Reset" submitLabel="Reset to suspected" />}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {!active.length && <p className="text-sm text-ink-muted">No issue labels yet.</p>}
        {canCorrect && <AddLabelForm action={actions.add} interactionId={iid} categories={categories} products={products} />}
        {removed.length > 0 && (
          <details className="text-xs text-ink-muted">
            <summary className="cursor-pointer hover:text-ink">Removed labels ({removed.length})</summary>
            <ul className="mt-1 space-y-0.5">{removed.map((l) => <li key={l.id} className="line-through">{l.category_name}{l.subcategory_name ? ` › ${l.subcategory_name}` : ''} ({l.source})</li>)}</ul>
          </details>
        )}
      </CardBody>
    </Card>
  );
}

// ───────────────────────── Flags ─────────────────────────
function flagLocation(f: FlagRow, d: InteractionDetail) {
  const ev = f.evidence_ref ?? {};
  if (ev.segment_seq !== undefined || ev.start_ms !== undefined) return `at ${fmtMs(ev.start_ms ?? d.segments.find((s) => s.seq === ev.segment_seq)?.start_ms ?? 0)}`;
  if (ev.sent_at) return `message at ${fmtDateTime(ev.sent_at)}`;
  return null;
}

export function FlagsCard({ d, flags, selectedId, perms, reviewers, flagAction, hiddenCount }: {
  d: InteractionDetail; flags: FlagRow[]; selectedId: string | null;
  perms: { review: boolean; assign: boolean; coach: boolean }; reviewers: { id: string; name: string }[]; flagAction: FormAction; hiddenCount: number;
}) {
  return (
    <Card id="alerts">
      <CardHeader title="Quality alerts" subtitle={`${flags.length} alert${flags.length === 1 ? '' : 's'} on this interaction`} />
      <CardBody className="space-y-3">
        <Notice tone="info">AI flags are potential concerns. Confirm evidence before any consequential decision.</Notice>
        {flags.map((f) => {
          const loc = flagLocation(f, d);
          return (
            <div key={f.id} className={clsx('rounded-lg border p-3', f.id === selectedId ? 'border-amber-300 ring-2 ring-amber-200' : 'border-line')}>
              <div className="flex flex-wrap items-center gap-1.5">
                <SeverityBadge severity={f.severity} /><FlagStatusBadge status={f.status} />
                {f.escalated && <Badge tone="warn">Escalated</Badge>}
                {f.is_demo && <DemoBadge />}
              </div>
              <p className="mt-1.5 text-sm font-medium text-ink">{f.title}</p>
              <p className="text-2xs text-ink-muted">Rule: {f.rule_name ?? f.rule_code}{f.criterion_name ? ` · Criterion: ${f.criterion_name}` : ''}</p>
              <blockquote className="mt-2 border-l-2 border-amber-300 pl-2 text-[13px] italic text-ink">“{f.excerpt}”</blockquote>
              <p className="mt-1.5 text-xs"><span className="font-medium text-ink">Reason (AI):</span> <span className="text-ink-muted">{f.reason}</span></p>
              {f.recommended_correction && <p className="mt-1 text-xs"><span className="font-medium text-ink">Recommended correction:</span> <span className="text-ink-muted">{f.recommended_correction}</span></p>}
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-2xs text-ink-muted">
                <div><dt className="inline">Confidence: </dt><dd className="inline font-medium text-ink">{f.confidence ? fmtPct(Number(f.confidence), 0) : '—'}</dd></div>
                <div><dt className="inline">Raised: </dt><dd className="inline">{relTime(f.created_at)}</dd></div>
                <div><dt className="inline">Assignee: </dt><dd className="inline text-ink">{f.assignee_name ?? 'Unassigned'}</dd></div>
                {f.policy_title && <div><dt className="inline">Policy: </dt><dd className="inline"><Link className="link" href={`/knowledge-base/${f.policy_article_id}`}>{f.policy_title}{f.policy_version ? ` v${f.policy_version}` : ''}</Link></dd></div>}
              </dl>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Link href={`/inbox/${d.interaction.id}?flag=${f.id}#evidence`} scroll={false} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                  <AlertTriangle size={12} /> Show evidence{loc ? ` ${loc}` : ''}
                </Link>
              </div>
              {(perms.review || perms.assign) && (
                <div className="mt-2 border-t border-line pt-2">
                  <FlagActions flag={{ id: f.id, status: f.status, escalated: f.escalated, assigned_to: f.assigned_to }} action={flagAction} canReview={perms.review} canAssign={perms.assign} canCoach={perms.coach} reviewers={reviewers} />
                </div>
              )}
            </div>
          );
        })}
        {!flags.length && <p className="text-sm text-ink-muted">No quality alerts{hiddenCount ? ' confirmed by a reviewer' : ''} for this interaction.</p>}
        {hiddenCount > 0 && <p className="text-2xs text-ink-faint">{hiddenCount} unverified AI alert{hiddenCount === 1 ? ' is' : 's are'} awaiting human review and not shown for your role.</p>}
      </CardBody>
    </Card>
  );
}

// ───────────────────────── Review & notes ─────────────────────────
const DECISION_LABELS: Record<string, string> = {
  comment: 'added a note', status_changed: 'updated status', corrected: 'corrected the evaluation', manual_assessment: 'added a manual assessment',
  added: 'added a label', removed: 'removed a label', confirmed: 'confirmed', rejected: 'rejected', suspected: 'reset to suspected',
  start_review: 'started review', confirm: 'confirmed alert', false_positive: 'marked false positive', resolve: 'resolved alert', reopen: 'reopened alert',
  assign: 'assigned reviewer', unassign: 'removed reviewer', escalate: 'escalated alert',
};

export function ReviewCard({ d, canEdit, actions }: { d: InteractionDetail; canEdit: boolean; actions: { status: FormAction; note: FormAction } }) {
  const iid = d.interaction.id;
  return (
    <Card id="review">
      <CardHeader title="Review & resolution" subtitle="Final review status, resolution and reviewer notes" />
      <CardBody className="space-y-4">
        {canEdit ? (
          <ActionForm action={actions.status} hidden={{ interactionId: iid }} className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="block"><span className="label">Resolution status</span>
                <select name="resolution" defaultValue={d.interaction.resolution_status} className="input h-8 py-0 text-xs">
                  {RESOLUTION_STATUSES.map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}
                </select>
              </label>
              <label className="block"><span className="label">Review status</span>
                <select name="review" defaultValue={d.interaction.review_status} className="input h-8 py-0 text-xs">
                  {REVIEW_STATUSES.map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}
                </select>
              </label>
            </div>
            <input name="note" placeholder="Reason for change (optional)" aria-label="Reason for status change" className="input h-8 text-xs" maxLength={1000} />
            <SubmitButton variant="primary">Update status</SubmitButton>
          </ActionForm>
        ) : (
          <div className="flex gap-3 text-sm"><span>Resolution: <span className="font-medium">{titleCase(d.interaction.resolution_status)}</span></span><span>Review: <ReviewBadge status={d.interaction.review_status} /></span></div>
        )}
        {canEdit && (
          <ActionForm action={actions.note} hidden={{ interactionId: iid }} resetOnSuccess className="space-y-1.5 border-t border-line pt-3">
            <label className="block"><span className="label">Reviewer note</span>
              <textarea name="note" required minLength={2} rows={2} className="input h-auto py-1.5 text-xs" placeholder="Visible to reviewers and managers; recorded in the audit trail." />
            </label>
            <SubmitButton>Add note</SubmitButton>
          </ActionForm>
        )}
        <div className="border-t border-line pt-3">
          <SectionTitle>Activity</SectionTitle>
          {d.decisions.length ? (
            <ol className="space-y-2">
              {d.decisions.map((x: any) => (
                <li key={x.id} className="text-xs">
                  <p><span className="font-medium text-ink">{x.reviewer_name ?? 'System'}</span> <span className="text-ink-muted">{DECISION_LABELS[x.decision] ?? x.decision.replace(/_/g, ' ')}</span>
                    {x.target_type !== 'interaction' && <span className="text-ink-faint"> · {x.target_type.replace('_', ' ')}</span>}
                    <span className="text-ink-faint"> · {relTime(x.created_at)}</span></p>
                  {x.decision === 'status_changed' && x.after_state && (
                    <p className="text-ink-muted">{titleCase(x.before_state?.resolution_status)} → {titleCase(x.after_state.resolution_status)} · {titleCase(x.before_state?.review_status)} → {titleCase(x.after_state.review_status)}</p>
                  )}
                  {(x.decision === 'corrected' || x.decision === 'manual_assessment') && x.after_state && (
                    <p className="text-ink-muted">Score {x.before_state?.overall_score ?? '—'} → {x.after_state.overall_score ?? '—'}</p>
                  )}
                  {x.notes && <p className="mt-0.5 whitespace-pre-wrap rounded-md bg-canvas px-2 py-1 text-ink">{x.notes}</p>}
                </li>
              ))}
            </ol>
          ) : <p className="text-xs text-ink-faint">No reviewer activity yet.</p>}
        </div>
      </CardBody>
    </Card>
  );
}
