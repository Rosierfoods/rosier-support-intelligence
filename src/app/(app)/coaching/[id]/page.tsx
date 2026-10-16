import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { SqlBuilder } from '@/lib/sql';
import { scopeAgents } from '@/lib/repos/scope';
import { COACHING_METRIC_DEFS, COACHING_STATUS_LABELS, criterionOptions, getCoaching, measureMetric, metricLabel } from '@/lib/repos/coaching';
import { ActionForm } from '@/components/analytics/ActionForm';
import { SubmitButton } from '@/components/analytics/SubmitButton';
import { CoachingProgress, coachingTone } from '@/components/analytics/coachingUi';
import { Badge, ButtonLink, Card, CardBody, CardHeader, DemoBadge, Field, KeyValue, Notice, PageHeader, SectionTitle } from '@/components/ui';
import { ChannelBadge, FlagStatusBadge, SeverityBadge } from '@/components/badges';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { MIN_SAMPLE } from '@/components/analytics/format';
import { acknowledgeCoaching, cancelCoaching, completeCoaching, reviewCoaching, setCoachingGoal, startCoaching } from '../actions';
import { Check, Circle } from 'lucide-react';

export const metadata = { title: 'Coaching plan' };

function Block({ title, children }: { title: string; children?: string | null }) {
  if (!children) return null;
  return <div><SectionTitle>{title}</SectionTitle><p className="whitespace-pre-line text-sm leading-relaxed text-ink">{children}</p></div>;
}

export default async function CoachingDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = await requireSession();
  const d = await withOrg(s.org.id, async (db) => {
    const c = await getCoaching(db, s, params.id);
    if (!c) return null;
    const measured = c.assigned_at ? await measureMetric(db, c.agent_id, c.target_metric, new Date(c.assigned_at)) : { value: null, n: 0 };
    const events = await db.query<{ action: string; created_at: string; user_name: string | null }>(
      `SELECT l.action, l.created_at, u.name AS user_name FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.target_type = 'coaching_action' AND l.target_id = $1 ORDER BY l.created_at`, [c.id]);
    const verification = c.flag_id ? await db.one<{ created_at: string; name: string | null; decision: string }>(
      `SELECT rd.created_at, u.name, rd.decision FROM reviewer_decisions rd LEFT JOIN users u ON u.id = rd.reviewer_id
        WHERE rd.target_type = 'flag' AND rd.target_id = $1 AND rd.decision IN ('confirm','start_review') ORDER BY rd.created_at LIMIT 1`, [c.flag_id]) : null;
    const criteria = await criterionOptions(db);
    const b = new SqlBuilder();
    const manageable = s.permissions.has('coaching.assign')
      ? !!(await db.one(`SELECT 1 FROM agents WHERE id = ${b.p(c.agent_id)} AND ${scopeAgents(s, b, 'id')}`, b.params)) : false;
    return { c, measured, events, verification, criteria, manageable };
  });
  if (!d) notFound();
  const { c, measured } = d;
  const isOwner = !!s.user.agentId && s.user.agentId === c.agent_id;
  const closed = ['reviewed', 'cancelled'].includes(c.status);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const reviewDate: string | null = c.review_date_str ?? null;
  // review dates are calendar dates in IST

  const overdue = !!reviewDate && reviewDate < today && ['assigned', 'acknowledged', 'in_progress', 'completed'].includes(c.status);
  const baseline = c.baseline_value !== null ? Number(c.baseline_value) : null;
  const target = c.target_value !== null ? Number(c.target_value) : null;
  const delta = measured.value !== null && baseline !== null ? measured.value - baseline : null;
  const ev = (a: string) => d.events.find((e) => e.action === a);

  const timeline: { label: string; at?: string | null; who?: string | null; done: boolean; note?: string | null }[] = [
    { label: 'AI identified a potential issue', at: c.flag_id ? c.interaction_at : null, done: !!c.flag_id, note: c.flag_id ? c.flag_title : 'Manual coaching — no AI alert' },
    { label: 'Human reviewer verified the evidence', at: d.verification?.created_at, who: d.verification?.name, done: !!d.verification || !c.flag_id, note: !c.flag_id ? 'Not applicable' : null },
    { label: 'Manager assigned coaching', at: c.assigned_at, who: c.assigned_by_name, done: !!c.assigned_at },
    { label: 'Agent acknowledged the feedback', at: c.acknowledged_at, who: c.acknowledged_at ? c.agent : null, done: !!c.acknowledged_at, note: c.agent_comment ? `“${c.agent_comment}”` : null },
    { label: 'Manager set the improvement goal', at: ev('coaching.set_goal')?.created_at ?? (c.goal ? c.assigned_at : null), who: ev('coaching.set_goal')?.user_name ?? (c.goal ? c.assigned_by_name : null), done: !!c.goal, note: c.goal },
    { label: 'Agent worked on the plan', at: ev('coaching.start')?.created_at ?? c.completed_at, done: ['in_progress', 'completed', 'reviewed'].includes(c.status), note: c.completed_at ? `Completed ${fmtDateTime(c.completed_at)}` : null },
    { label: 'Platform measured subsequent performance', done: measured.n > 0, note: measured.n ? `${measured.n} data points since assignment` : 'No evaluated interactions since assignment yet' },
    { label: 'Manager reviewed the outcome', at: c.reviewed_at, who: c.reviewed_by_name, done: !!c.reviewed_at, note: c.outcome ? `Outcome: ${c.outcome.replace('_', ' ')}${c.outcome_notes ? ` — ${c.outcome_notes}` : ''}` : null },
  ];

  return (
    <div className="space-y-5">
      <PageHeader title={c.title}
        description={<span className="flex flex-wrap items-center gap-2">
          <Link href={`/agents/${c.agent_id}`} className="font-medium text-ink hover:text-brand">{c.agent}</Link>{c.team && <span>· {c.team}</span>}
          <Badge tone={coachingTone(c.status)}>{COACHING_STATUS_LABELS[c.status]}</Badge>
          {overdue && <Badge tone="bad">Review overdue</Badge>}
          <Badge tone="muted">{c.source === 'ai' ? 'AI-drafted, human-assigned' : 'Manual'}</Badge>
          {c.is_demo && <DemoBadge />}
        </span>}
        actions={<ButtonLink href="/coaching" size="sm">All coaching</ButtonLink>}>
        <div className="mt-3"><CoachingProgress status={c.status} /></div>
      </PageHeader>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader title="Coaching plan" subtitle={`Created ${fmtDateTime(c.created_at)}${c.created_by_name ? ` by ${c.created_by_name}` : ''}`} />
            <CardBody className="space-y-4">
              <Block title="What went wrong">{c.what_went_wrong}</Block>
              <Block title="Why it matters">{c.why_it_matters}</Block>
              {c.evidence && (
                <div>
                  <SectionTitle>Evidence from the interaction</SectionTitle>
                  <blockquote className="rounded-lg border-l-4 border-brand-500 bg-brand-50/60 px-3 py-2 text-sm text-ink">{c.evidence}</blockquote>
                  {c.interaction_id && (
                    <p className="mt-1.5 text-xs">
                      <Link className="text-brand hover:underline" href={`/inbox/${c.interaction_id}${c.flag_id ? `?flag=${c.flag_id}` : ''}`}>Open {c.interaction_ref} with the evidence highlighted →</Link>
                      {c.interaction_channel && <span className="ml-2 text-ink-muted"><ChannelBadge channel={c.interaction_channel} /></span>}
                    </p>
                  )}
                </div>
              )}
              <div>
                <SectionTitle>Correct SOP / policy</SectionTitle>
                {c.kb_article_id ? (
                  <p className="text-sm"><Link className="text-brand hover:underline" href={`/knowledge-base/${c.kb_article_id}`}>{c.kb_title} (v{c.kb_version})</Link>{c.sop_reference && <span className="text-ink-muted"> · {c.sop_reference}</span>}</p>
                ) : <p className="text-sm text-ink">{c.sop_reference ?? <span className="text-ink-muted">No approved policy linked.</span>}</p>}
              </div>
              {c.better_response && (
                <div>
                  <SectionTitle>Example of a better response</SectionTitle>
                  <p className="whitespace-pre-line rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm leading-relaxed text-emerald-950">{c.better_response}</p>
                </div>
              )}
              <Block title="Recommended action">{c.recommended_action}</Block>
              <Block title="Coaching exercise">{c.exercise}</Block>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Measured improvement" subtitle={<span title={COACHING_METRIC_DEFS.measured}>{metricLabel(c.target_metric)} on interactions after {fmtDate(c.assigned_at)} ⓘ</span>} />
            <CardBody>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {([['Baseline', baseline], ['Target', target], ['Measured since assignment', measured.value]] as [string, number | null][]).map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-line px-3 py-2">
                    <p className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{k}</p>
                    <p className="text-xl font-semibold tabular-nums text-ink">{v !== null ? v.toFixed(1) : '—'}</p>
                  </div>
                ))}
                <div className="rounded-lg border border-line px-3 py-2">
                  <p className="text-2xs font-medium uppercase tracking-wide text-ink-faint">Change vs baseline</p>
                  <p className={`text-xl font-semibold tabular-nums ${delta === null ? 'text-ink' : delta >= 0 ? 'text-emerald-800' : 'text-amber-800'}`}>{delta !== null ? `${delta > 0 ? '+' : ''}${delta.toFixed(1)}` : '—'}</p>
                </div>
              </div>
              <p className="mt-2 text-xs text-ink-muted">
                n = {measured.n} {c.target_metric && c.target_metric !== 'quality_score' ? 'criterion scores' : 'evaluated interactions'} since assignment.
                {measured.n < MIN_SAMPLE && ` Fewer than ${MIN_SAMPLE} data points — treat the measured value as indicative only.`}
                {target !== null && measured.value !== null && measured.n >= MIN_SAMPLE && (measured.value >= target ? ' Target reached.' : ` ${(target - measured.value).toFixed(1)} points below target.`)}
              </p>
              {c.outcome_value !== null && <p className="mt-1 text-xs text-ink-muted">Value recorded at review: <span className="font-medium text-ink">{Number(c.outcome_value).toFixed(1)}</span></p>}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-4">
          {isOwner && !closed && (
            <Card>
              <CardHeader title="Your next step" />
              <CardBody>
                {c.status === 'assigned' && (
                  <ActionForm action={acknowledgeCoaching} className="space-y-3">
                    <input type="hidden" name="id" value={c.id} />
                    <p className="text-sm text-ink-muted">Read the plan, then acknowledge it. You can add a comment for your manager.</p>
                    <Field label="Comment (optional)"><textarea name="comment" rows={3} maxLength={2000} className="input h-auto py-2" /></Field>
                    <SubmitButton>Acknowledge feedback</SubmitButton>
                  </ActionForm>
                )}
                {c.status === 'acknowledged' && (
                  <div className="space-y-2">
                    <ActionForm action={startCoaching}><input type="hidden" name="id" value={c.id} /><SubmitButton>Mark in progress</SubmitButton></ActionForm>
                    <ActionForm action={completeCoaching}><input type="hidden" name="id" value={c.id} /><SubmitButton variant="secondary">Mark completed</SubmitButton></ActionForm>
                  </div>
                )}
                {c.status === 'in_progress' && (
                  <ActionForm action={completeCoaching} className="space-y-3">
                    <input type="hidden" name="id" value={c.id} />
                    <Field label="What did you practise? (optional)"><textarea name="comment" rows={3} maxLength={2000} className="input h-auto py-2" /></Field>
                    <SubmitButton>Mark completed</SubmitButton>
                  </ActionForm>
                )}
                {c.status === 'completed' && <p className="text-sm text-ink-muted">Completed — waiting for your manager’s review.</p>}
              </CardBody>
            </Card>
          )}

          {d.manageable && !closed && (
            <Card>
              <CardHeader title="Manager actions" />
              <CardBody className="space-y-5">
                <ActionForm action={setCoachingGoal} className="space-y-3">
                  <input type="hidden" name="id" value={c.id} />
                  <Field label="Improvement goal"><textarea name="goal" rows={2} required defaultValue={c.goal ?? ''} maxLength={1000} className="input h-auto py-2" /></Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Metric">
                      <select name="targetMetric" defaultValue={c.target_metric ?? 'quality_score'} className="input">
                        <option value="quality_score">Overall quality score</option>
                        {d.criteria.map((k) => <option key={k.code} value={k.code}>{k.name}</option>)}
                      </select>
                    </Field>
                    <Field label="Target (0–100)"><input name="targetValue" type="number" min={0} max={100} step="any" defaultValue={target ?? ''} className="input" /></Field>
                  </div>
                  <Field label="Review date"><input name="reviewDate" type="date" defaultValue={reviewDate ?? ''} className="input" /></Field>
                  <SubmitButton variant="secondary" size="sm">Save goal</SubmitButton>
                </ActionForm>
                {c.status !== 'assigned' && (
                  <ActionForm action={reviewCoaching} className="space-y-3 border-t border-line pt-4">
                    <input type="hidden" name="id" value={c.id} />
                    <p className="text-xs text-ink-muted">Recording a review stores the measured value ({measured.value !== null ? measured.value.toFixed(1) : 'no data'}, n={measured.n}){c.flag_id ? ' and resolves the linked alert' : ''}.</p>
                    <Field label="Outcome">
                      <select name="outcome" required defaultValue="" className="input">
                        <option value="" disabled>Choose…</option>
                        <option value="improved">Improved</option><option value="no_change">No change</option><option value="worsened">Worsened</option>
                      </select>
                    </Field>
                    <Field label="Notes"><textarea name="notes" rows={2} maxLength={2000} className="input h-auto py-2" /></Field>
                    <SubmitButton size="sm">Record review</SubmitButton>
                  </ActionForm>
                )}
                <ActionForm action={cancelCoaching} className="space-y-2 border-t border-line pt-4">
                  <input type="hidden" name="id" value={c.id} />
                  <Field label="Cancel plan — reason (optional)"><input name="comment" maxLength={500} className="input" /></Field>
                  <SubmitButton variant="ghost" size="sm" confirm="Cancel this coaching plan?">Cancel plan</SubmitButton>
                </ActionForm>
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader title="Workflow timeline" />
            <CardBody>
              <ol className="space-y-3">
                {timeline.map((t, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${t.done ? 'bg-brand text-white' : 'border border-line text-ink-faint'}`}>
                      {t.done ? <Check size={12} aria-hidden /> : <Circle size={8} aria-hidden />}
                    </span>
                    <div className="min-w-0">
                      <p className={`text-sm ${t.done ? 'text-ink' : 'text-ink-muted'}`}>{t.label}<span className="sr-only">{t.done ? ' (done)' : ' (pending)'}</span></p>
                      {(t.at || t.who) && <p className="text-2xs text-ink-faint">{t.at ? fmtDateTime(t.at) : ''}{t.who ? ` · ${t.who}` : ''}</p>}
                      {t.note && <p className="mt-0.5 text-xs text-ink-muted">{t.note}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <KeyValue items={[
                ['Review date', overdue ? <span className="font-medium text-red-800">{fmtDate(c.review_date)} (overdue)</span> : fmtDate(c.review_date)],
                ['Target metric', metricLabel(c.target_metric)],
                ['Assigned by', c.assigned_by_name ?? '—'],
                ['Linked alert', c.flag_id ? <span className="flex flex-wrap gap-1">{c.flag_severity && <SeverityBadge severity={c.flag_severity} />}{c.flag_status && <FlagStatusBadge status={c.flag_status} />}</span> : 'None (manual)'],
              ]} />
            </CardBody>
          </Card>
          {closed && <Notice tone={c.status === 'reviewed' ? 'good' : 'info'}>{c.status === 'reviewed' ? 'This plan has been reviewed and is closed.' : 'This plan was cancelled.'}</Notice>}
        </div>
      </div>
    </div>
  );
}
