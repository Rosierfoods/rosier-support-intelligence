import Link from 'next/link';
import { daysFromNow } from '@/lib/format';
import { requirePermission } from '@/lib/auth/session';
import { withOrg, isUuid } from '@/lib/db';
import { sp, type SP } from '@/lib/filters';
import { draftCoachingFromFlag, type CoachingDraft } from '@/lib/ai/coaching';
import { coachingAgentOptions, criterionOptions, getFlagForCoaching, measureMetric } from '@/lib/repos/coaching';
import { ActionForm } from '@/components/analytics/ActionForm';
import { SubmitButton } from '@/components/analytics/SubmitButton';
import { ButtonLink, Card, CardBody, CardHeader, DemoBadge, Field, Notice, PageHeader } from '@/components/ui';
import { ChannelBadge, FlagStatusBadge, SeverityBadge } from '@/components/badges';
import { fmtDate } from '@/lib/format';
import { createCoachingAction } from '../actions';

export const metadata = { title: 'New coaching' };

function TA({ name, label, value, rows = 3, required, hint }: { name: string; label: string; value?: string | null; rows?: number; required?: boolean; hint?: string }) {
  return (
    <Field label={label + (required ? ' *' : '')} hint={hint}>
      <textarea name={name} defaultValue={value ?? ''} rows={rows} required={required} className="input h-auto py-2 leading-relaxed" />
    </Field>
  );
}

export default async function NewCoachingPage(props: { searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const s = await requirePermission('coaching.assign');
  const flagId = sp(searchParams, 'flag');
  const agentParam = sp(searchParams, 'agent');

  const d = await withOrg(s.org.id, async (db) => {
    const [agents, criteria] = await Promise.all([coachingAgentOptions(db, s), criterionOptions(db)]);
    let flag: any = null;
    let draft: CoachingDraft | null = null;
    let hint: { value: number | null; n: number } | null = null;
    if (flagId && isUuid(flagId)) {
      flag = await getFlagForCoaching(db, s, flagId);
      if (flag) {
        draft = await draftCoachingFromFlag(db, flag.id);
        if (flag.agent_id && draft) hint = await measureMetric(db, flag.agent_id, draft.targetMetric, daysFromNow(-30));
      }
    }
    return { agents, criteria, flag, draft, hint };
  });

  if (flagId && !d.flag) {
    return (
      <div><PageHeader title="New coaching" />
        <Notice tone="bad" title="Alert not found">The quality alert doesn’t exist or is outside your data scope. <Link className="underline" href="/quality">Back to the review queue</Link></Notice>
      </div>
    );
  }
  const fl = d.flag;
  const blocked = fl && (fl.existing_coaching_id || !['new', 'under_review', 'confirmed'].includes(fl.status) || !fl.agent_id);
  const needsConfirm = fl?.status === 'new';
  const dr = d.draft;
  const metricOptions = [{ code: 'quality_score', name: 'Overall quality score (0–100)' }, ...d.criteria.map((c) => ({ code: c.code, name: `${c.name} (criterion, 0–100)` }))];

  return (
    <div className="space-y-5">
      <PageHeader title={fl ? 'Assign coaching from a quality alert' : 'New manual coaching'}
        description={fl ? 'The AI draft below uses only the alert evidence and approved knowledge-base policy. Edit anything before assigning.' : 'Create a coaching plan that is not linked to a specific alert.'}
        actions={<ButtonLink href="/coaching" size="sm">Cancel</ButtonLink>} />

      {fl && (
        <Card>
          <CardHeader title={<span className="flex flex-wrap items-center gap-2">{fl.title} <SeverityBadge severity={fl.severity} /> <FlagStatusBadge status={fl.status} />{fl.is_demo && <DemoBadge />}</span>}
            subtitle={<>{fl.agent ?? 'No agent'} · {fl.ref} · <ChannelBadge channel={fl.channel} /> · {fmtDate(fl.occurred_at)}</>}
            actions={<Link href={`/inbox/${fl.interaction_id}?flag=${fl.id}`} className="text-xs text-brand hover:underline">Open evidence →</Link>} />
          <CardBody><blockquote className="rounded-lg border-l-4 border-brand-500 bg-brand-50/60 px-3 py-2 text-sm text-ink">“{fl.excerpt}”</blockquote></CardBody>
        </Card>
      )}

      {blocked ? (
        <Notice tone="warn" title="Coaching can’t be assigned from this alert">
          {fl.existing_coaching_id ? <>Coaching already exists for this alert. <Link className="underline" href={`/coaching/${fl.existing_coaching_id}`}>Open it</Link>.</>
            : !fl.agent_id ? 'The alert has no agent attached.'
              : <>The alert is “{fl.status.replace('_', ' ')}”. Only alerts under review or confirmed by a person can lead to coaching.</>}
        </Notice>
      ) : (
        <ActionForm action={createCoachingAction} className="space-y-5">
          <input type="hidden" name="flagId" value={fl?.id ?? ''} />
          <input type="hidden" name="source" value={fl ? 'ai' : 'manual'} />
          <input type="hidden" name="policyVersionId" value={dr?.policyVersionId ?? ''} />
          {needsConfirm && (
            <Notice tone="warn" title="Human verification required before coaching">
              This alert is still <strong>New</strong> — the AI found a potential issue but nobody has verified the evidence yet (workflow step 2).
              Read the excerpt and the full conversation first.
              <label className="mt-2 flex items-start gap-2 font-medium">
                <input type="checkbox" name="confirmFlag" required className="mt-0.5 h-4 w-4 accent-[#784900]" />
                I have reviewed the evidence and confirm this alert{!s.permissions.has('flags.review') && ' (requires alert-review permission)'}.
              </label>
            </Notice>
          )}
          <Card>
            <CardHeader title="Plan" subtitle={dr ? <>Draft generated by: {dr.generatedBy} · review every field</> : 'All fields marked * are required'} />
            <CardBody className="grid gap-4 md:grid-cols-2">
              <Field label="Agent *">
                {fl ? (
                  <><input className="input" value={fl.agent} disabled readOnly /><input type="hidden" name="agentId" value={fl.agent_id} /></>
                ) : (
                  <select name="agentId" required defaultValue={agentParam && d.agents.some((a) => a.id === agentParam) ? agentParam : ''} className="input">
                    <option value="" disabled>Choose an agent…</option>
                    {d.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                )}
              </Field>
              <Field label="Title *"><input name="title" required maxLength={200} defaultValue={dr?.title ?? ''} className="input" /></Field>
              <TA name="whatWentWrong" label="What went wrong" value={dr?.whatWentWrong} required />
              <TA name="whyItMatters" label="Why it matters" value={dr?.whyItMatters} required />
              <TA name="evidence" label="Evidence from the interaction" value={dr?.evidence} hint="Quote the conversation; keep customer personal data out." />
              <div className="space-y-4">
                <Field label="SOP / policy reference" hint={dr?.sopReference ? 'From the approved knowledge-base version linked to the alert.' : 'Approved knowledge-base article and version.'}>
                  <input name="sopReference" defaultValue={dr?.sopReference ?? ''} maxLength={300} className="input" />
                </Field>
                <TA name="recommendedAction" label="Recommended action for the agent" value={dr?.recommendedAction} rows={2} />
              </div>
              <TA name="betterResponse" label="Example of a better response" value={dr?.betterResponse} rows={4} />
              <TA name="exercise" label="Coaching exercise" value={dr?.exercise} rows={4} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Goal & measurement" subtitle="The platform measures this metric on the agent’s interactions after assignment and compares it to the baseline." />
            <CardBody className="grid gap-4 md:grid-cols-3">
              <Field label="Target metric *">
                <select name="targetMetric" defaultValue={dr?.targetMetric ?? 'quality_score'} className="input">
                  {metricOptions.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
                </select>
              </Field>
              <Field label="Baseline (0–100)" hint={d.hint ? (d.hint.value !== null ? `Agent’s last-30-day average for the drafted metric: ${d.hint.value} (n=${d.hint.n}).` : 'No recent data for this metric.') : 'Current level of the metric.'}>
                <input name="baselineValue" type="number" min={0} max={100} step="any" defaultValue={dr?.baselineValue ?? ''} className="input" />
              </Field>
              <Field label="Target value (0–100)"><input name="targetValue" type="number" min={0} max={100} step="any" defaultValue={dr?.targetValue ?? ''} className="input" /></Field>
              <Field label="Review date *"><input name="reviewDate" type="date" required defaultValue={dr?.reviewDate ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(daysFromNow(14))} className="input" /></Field>
              <div className="md:col-span-2"><Field label="Improvement goal (shown to the agent)"><input name="goal" maxLength={1000} className="input" placeholder="e.g. Follow the leakage SOP on the next 5 similar cases" /></Field></div>
            </CardBody>
          </Card>
          <div className="flex items-center justify-end gap-2">
            <p className="mr-auto text-2xs text-ink-faint">Assigning notifies the agent{fl ? ', marks the alert “Coaching assigned”' : ''} and is recorded in the audit log.</p>
            <SubmitButton>Assign coaching</SubmitButton>
          </div>
        </ActionForm>
      )}
    </div>
  );
}
