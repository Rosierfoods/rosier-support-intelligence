import Link from 'next/link';
import { daysFromNow } from '@/lib/format';
import clsx from 'clsx';
import { requirePermission, can } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { sp, type SP } from '@/lib/filters';
import { CHANNELS, CHANNEL_LABELS, DEFAULT_GROUP_WEIGHTS, RUBRIC_GROUPS, RUBRIC_GROUP_LABELS, SEVERITIES, PROCESSING_LABELS } from '@/lib/constants';
import { Badge, Card, CardBody, CardHeader, Field, Notice, PageHeader, Table, TBody, THead } from '@/components/ui';
import { SeverityBadge } from '@/components/badges';
import { SubmitButton } from '@/components/analytics/SubmitButton';
import { fmtDateTime, relTime, titleCase } from '@/lib/format';
import { findProviderConnection } from '@/lib/ai/connections';
import { WeightsForm } from './WeightsForm';
import {
  addCategoryAction, reprocessAction, retryJobAction, saveBandsAction, saveBehaviourAction, saveSlaAction, saveWeightsAction,
  updateCategoryAction, updateCriterionAction, updateRuleAction,
} from './actions';

export const metadata = { title: 'AI Configuration' };

const TABS = [
  { key: 'rubric', label: 'Rubric & scoring' },
  { key: 'alerts', label: 'Alert rules' },
  { key: 'taxonomy', label: 'Issue taxonomy' },
  { key: 'behaviour', label: 'AI behaviour & SLA' },
  { key: 'processing', label: 'Processing queue' },
] as const;
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const GROUPS = RUBRIC_GROUPS.map((g) => ({ key: g, label: RUBRIC_GROUP_LABELS[g] }));

function ChannelChecks({ selected, name = 'channels' }: { selected: string[]; name?: string }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {CHANNELS.map((c) => (
        <label key={c} className="flex items-center gap-1 text-xs text-ink">
          <input type="checkbox" name={name} value={c} defaultChecked={selected.includes(c)} /> {CHANNEL_LABELS[c]}
        </label>
      ))}
    </div>
  );
}

export default async function AiConfigPage(props: { searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const s = await requirePermission('ai_config.manage');
  const tab = (TABS.find((t) => t.key === sp(searchParams, 'tab'))?.key ?? 'rubric') as (typeof TABS)[number]['key'];
  const ok = sp(searchParams, 'ok'), error = sp(searchParams, 'error');
  const settings = s.org.settings;

  const data = await withOrg(s.org.id, async (db) => {
    const claude = await findProviderConnection(db, 'anthropic', s.org.id).catch(() => null);
    const sarvam = await findProviderConnection(db, 'sarvam', s.org.id).catch(() => null);
    const base = { claude: claude ? String(claude.config.customModel || claude.config.model || 'claude-sonnet-5-5') : null, sarvam: !!sarvam };
    if (tab === 'rubric') {
      const criteria = await db.query(`SELECT code, name, description, group_code, channels, is_active FROM quality_criteria ORDER BY sort, code`);
      return { ...base, criteria };
    }
    if (tab === 'alerts') {
      const rules = await db.query(`SELECT r.code, r.name, r.description, r.severity, r.min_confidence, r.channels, r.is_active,
          (SELECT count(*)::int FROM quality_flags f WHERE f.rule_code = r.code AND f.created_at > now() - interval '30 days') AS flags_30d
        FROM alert_rules r ORDER BY array_position(ARRAY['critical','high','medium','low'], r.severity), r.code`);
      return { ...base, rules };
    }
    if (tab === 'taxonomy') {
      const cats = await db.query(`SELECT c.id, c.code, c.name, c.parent_id, c.is_active,
          (SELECT count(*)::int FROM interaction_issue_labels l WHERE l.is_active AND (l.category_id = c.id OR l.subcategory_id = c.id)) AS uses
        FROM issue_categories c ORDER BY c.sort, c.code`);
      return { ...base, cats };
    }
    if (tab === 'processing') {
      const byStatus = await db.query(`SELECT type, status, count(*)::int AS n FROM processing_jobs GROUP BY 1,2 ORDER BY 1,2`);
      const interactions = await db.query(`SELECT processing_status, count(*)::int AS n FROM interactions GROUP BY 1`);
      const failed = await db.query(`SELECT j.id, j.type, j.status, j.attempts, j.max_attempts, j.last_error, j.updated_at, j.run_after, i.id AS interaction_id, i.ref, i.is_demo
          FROM processing_jobs j LEFT JOIN interactions i ON i.id = j.interaction_id
         WHERE j.status IN ('dead','failed') OR (j.status = 'queued' AND j.last_error IS NOT NULL)
         ORDER BY j.updated_at DESC LIMIT 25`);
      const recent = await db.query(`SELECT type, status, count(*)::int AS n FROM processing_jobs WHERE updated_at > now() - interval '24 hours' GROUP BY 1,2`);
      return { ...base, byStatus, interactions, failed, recent };
    }
    return base;
  });

  return (
    <div className="space-y-5">
      <PageHeader title="AI Configuration" description="How interactions are scored, classified and flagged. Changes apply to new analyses; use Reprocess to re-run older ones." />

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={data.claude ? 'good' : 'warn'}>{data.claude ? `AI analysis: Claude · ${data.claude}` : 'AI analysis: not connected'}</Badge>
        <Badge tone={data.sarvam ? 'good' : 'warn'}>{data.sarvam ? 'Speech-to-text: Sarvam connected' : 'Speech-to-text: not connected'}</Badge>
        {(!data.claude || !data.sarvam) && can(s, 'integrations.manage') && <Link href="/integrations" className="link text-xs">Connect on the Integrations page</Link>}
      </div>
      {!data.claude && (
        <Notice tone="warn" title="No AI provider connected">
          Live interactions cannot be analysed until Claude is connected. Demo records are analysed by a clearly-labelled offline heuristic so the pipeline can be explored.
        </Notice>
      )}

      <nav className="flex flex-wrap gap-1 border-b border-line" aria-label="AI configuration sections">
        {TABS.map((t) => (
          <Link key={t.key} href={`/ai-config?tab=${t.key}`} aria-current={tab === t.key ? 'page' : undefined}
            className={clsx('-mb-px border-b-2 px-3 py-2 text-sm font-medium', tab === t.key ? 'border-brand text-brand' : 'border-transparent text-ink-muted hover:text-ink')}>
            {t.label}
          </Link>
        ))}
      </nav>

      {ok && <Notice tone="good">{ok}</Notice>}
      {error && <Notice tone="bad" title="Not saved">{error}</Notice>}

      {tab === 'rubric' && 'criteria' in data && (
        <>
          <Card>
            <CardHeader title="Rubric group weights" subtitle="Default 100-point rubric, optionally overridden per channel. Each set must total 100. Groups whose criteria are all N/A are excluded and the score is normalised." />
            <CardBody className="grid gap-3 lg:grid-cols-2">
              <WeightsForm action={saveWeightsAction} scope="default" label="Default (all channels)" groups={GROUPS} initial={{ ...DEFAULT_GROUP_WEIGHTS, ...settings.rubric.default }} />
              {CHANNELS.map((c) => {
                const ov = (settings.rubric.overrides as Record<string, Record<string, number> | undefined>)?.[c];
                return <WeightsForm key={c} action={saveWeightsAction} scope={c} label={`${CHANNEL_LABELS[c]} override`} groups={GROUPS}
                  initial={{ ...DEFAULT_GROUP_WEIGHTS, ...settings.rubric.default, ...(ov ?? {}) }} inherited={!ov} fallback={{ ...DEFAULT_GROUP_WEIGHTS, ...settings.rubric.default }} />;
              })}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Quality criteria" subtitle="Scored 0–5 or N/A by the evaluator. Disable a criterion or limit it to specific channels." />
            <Table>
              <THead><tr><th className="th p-0" colSpan={5}><div className="hidden gap-2 px-3 py-2 md:grid md:grid-cols-[minmax(0,2fr)_9rem_minmax(0,1.4fr)_5rem_3.5rem]"><span>Criterion</span><span>Group</span><span>Channels</span><span>Active</span><span></span></div></th></tr></THead>
              <TBody>
                {data.criteria.map((c: any) => (
                  <tr key={c.code} className={clsx(!c.is_active && 'bg-canvas/60')}>
                    <td className="td" colSpan={5}>
                      <form action={updateCriterionAction} className="grid gap-2 md:grid-cols-[minmax(0,2fr)_9rem_minmax(0,1.4fr)_5rem_3.5rem] md:items-start">
                        <input type="hidden" name="code" value={c.code} />
                        <div className="space-y-1">
                          <input name="name" defaultValue={c.name} className="input h-8" aria-label={`Name of ${c.code}`} required />
                          <textarea name="description" defaultValue={c.description} rows={2} className="input h-auto py-1.5 text-xs" aria-label={`Description of ${c.code}`} required />
                          <p className="font-mono text-2xs text-ink-faint">{c.code}</p>
                        </div>
                        <p className="pt-1.5 text-xs text-ink-muted">{RUBRIC_GROUP_LABELS[c.group_code as keyof typeof RUBRIC_GROUP_LABELS] ?? c.group_code}</p>
                        <div className="pt-1.5"><ChannelChecks selected={c.channels} /></div>
                        <label className="flex items-center gap-1.5 pt-1.5 text-xs"><input type="checkbox" name="is_active" defaultChecked={c.is_active} /> Active</label>
                        <div className="pt-0.5"><SubmitButton variant="secondary" size="sm">Save</SubmitButton></div>
                      </form>
                    </td>
                  </tr>
                ))}
              </TBody>
            </Table>
          </Card>

          <Card>
            <CardHeader title="Score bands & review threshold" subtitle="Bands label overall scores; interactions scoring below the review threshold are highlighted for human QA." />
            <CardBody>
              <form action={saveBandsAction} className="space-y-3">
                <div className="grid gap-2">
                  {[...settings.scoreBands, ...Array.from({ length: Math.max(0, 5 - settings.scoreBands.length) }, () => ({ label: '', min: '' as any, tone: 'warn' }))].slice(0, 6).map((b: any, k: number) => (
                    <div key={k} className="grid grid-cols-[minmax(0,1fr)_7rem_9rem] gap-2">
                      <input name="band_label" defaultValue={b.label} placeholder="Band label (leave empty to remove)" className="input" aria-label={`Band ${k + 1} label`} />
                      <input name="band_min" type="number" min={0} max={100} step="any" defaultValue={b.min} placeholder="Min" className="input tabular-nums" aria-label={`Band ${k + 1} minimum score`} />
                      <select name="band_tone" defaultValue={b.tone ?? 'warn'} className="input" aria-label={`Band ${k + 1} colour`}>
                        <option value="good">Green</option><option value="warn">Amber</option><option value="bad">Red</option>
                      </select>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Review threshold (score below → needs review)"><input name="reviewThreshold" type="number" min={0} max={100} defaultValue={settings.reviewThreshold} className="input w-40 tabular-nums" /></Field>
                  <SubmitButton size="md">Save bands</SubmitButton>
                </div>
              </form>
            </CardBody>
          </Card>
        </>
      )}

      {tab === 'alerts' && 'rules' in data && (
        <Card>
          <CardHeader title="Alert rules" subtitle="Flags are raised only with linked evidence and at or above the minimum confidence. They are potential concerns for human review — never automatic disciplinary findings." />
          <Table>
            <THead><tr><th className="th p-0" colSpan={7}><div className="hidden gap-2 px-3 py-2 lg:grid lg:grid-cols-[minmax(0,2.2fr)_7.5rem_6.5rem_minmax(0,1.4fr)_4.5rem_4rem_3.5rem]"><span>Rule</span><span>Severity</span><span>Min confidence</span><span>Channels</span><span>Active</span><span>30 d flags</span><span></span></div></th></tr></THead>
            <TBody>
              {data.rules.map((r: any) => (
                <tr key={r.code} className={clsx(!r.is_active && 'bg-canvas/60')}>
                  <td className="td" colSpan={7}>
                    <form action={updateRuleAction} className="grid gap-2 lg:grid-cols-[minmax(0,2.2fr)_7.5rem_6.5rem_minmax(0,1.4fr)_4.5rem_4rem_3.5rem] lg:items-start">
                      <input type="hidden" name="code" value={r.code} />
                      <div>
                        <p className="flex items-center gap-2 font-medium text-ink">{r.name} <SeverityBadge severity={r.severity} /></p>
                        <p className="text-xs text-ink-muted">{r.description}</p>
                        <p className="font-mono text-2xs text-ink-faint">{r.code}{['excessive_delay', 'sla_unresolved', 'repeated_critical_failures'].includes(r.code) && ' · computed by the platform (not the AI)'}</p>
                      </div>
                      <select name="severity" defaultValue={r.severity} className="input h-8" aria-label={`Severity of ${r.code}`}>
                        {SEVERITIES.map((sv) => <option key={sv} value={sv}>{titleCase(sv)}</option>)}
                      </select>
                      <input name="min_confidence" type="number" min={0} max={1} step={0.05} defaultValue={Number(r.min_confidence)} className="input h-8 tabular-nums" aria-label={`Minimum confidence for ${r.code}`} />
                      <div className="pt-1.5"><ChannelChecks selected={r.channels} /></div>
                      <label className="flex items-center gap-1.5 pt-1.5 text-xs"><input type="checkbox" name="is_active" defaultChecked={r.is_active} /> On</label>
                      <p className="pt-1.5 text-xs tabular-nums text-ink-muted">{r.flags_30d}</p>
                      <div><SubmitButton variant="secondary" size="sm">Save</SubmitButton></div>
                    </form>
                  </td>
                </tr>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      {tab === 'taxonomy' && 'cats' in data && (() => {
        const parents = data.cats.filter((c: any) => !c.parent_id);
        return (
          <>
            <Card>
              <CardHeader title="Add a category or subcategory" subtitle="Codes are permanent identifiers used in analytics; names can be renamed later. Deactivated entries are no longer suggested by the AI but existing labels are kept." />
              <CardBody>
                <form action={addCategoryAction} className="grid gap-3 md:grid-cols-[14rem_12rem_minmax(0,1fr)_auto] md:items-end">
                  <Field label="Parent">
                    <select name="parent_id" className="input" defaultValue="">
                      <option value="">— New top-level category —</option>
                      {parents.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Code" hint="lowercase, e.g. seal_broken"><input name="code" required pattern="[a-z][a-z0-9_]{1,40}" className="input font-mono" /></Field>
                  <Field label="Name"><input name="name" required maxLength={120} className="input" placeholder="e.g. Seal broken on arrival" /></Field>
                  <SubmitButton size="md">Add</SubmitButton>
                </form>
              </CardBody>
            </Card>
            <div className="grid gap-4 lg:grid-cols-2">
              {parents.map((p: any) => (
                <Card key={p.id} className={clsx(!p.is_active && 'opacity-70')}>
                  <CardHeader title={<span className="flex items-center gap-2">{p.name} {!p.is_active && <Badge tone="muted">Inactive</Badge>}</span>}
                    subtitle={<span className="font-mono">{p.code} · {p.uses} active labels</span>}
                    actions={<CategoryToggle c={p} />} />
                  <CardBody className="space-y-1.5">
                    <CategoryRename c={p} />
                    <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
                      {data.cats.filter((c: any) => c.parent_id === p.id).map((c: any) => (
                        <li key={c.id} className={clsx('flex flex-wrap items-center gap-2 px-2 py-1.5', !c.is_active && 'bg-canvas/60')}>
                          <div className="min-w-0 flex-1"><CategoryRename c={c} compact /></div>
                          <span className="font-mono text-2xs text-ink-faint">{c.code.split('.')[1]}</span>
                          <span className="w-14 text-right text-2xs tabular-nums text-ink-muted" title="Active labels">{c.uses} uses</span>
                          <CategoryToggle c={c} />
                        </li>
                      ))}
                    </ul>
                  </CardBody>
                </Card>
              ))}
            </div>
          </>
        );
      })()}

      {tab === 'behaviour' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="AI behaviour" />
            <CardBody>
              <form action={saveBehaviourAction} className="space-y-3">
                <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="autoAnalyze" defaultChecked={settings.ai.autoAnalyze} className="mt-1" />
                  <span><span className="font-medium">Auto-analyse new interactions</span><span className="block text-xs text-ink-muted">Transcribe and analyse as soon as interactions are imported. Off = analyse only on manual reprocess.</span></span></label>
                <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="translateToEnglish" defaultChecked={settings.ai.translateToEnglish} className="mt-1" />
                  <span><span className="font-medium">Provide English translation</span><span className="block text-xs text-ink-muted">Original Hindi/Hinglish text is always preserved; an English translation is stored alongside.</span></span></label>
                <Field label="Review confidence threshold (0–1)" hint="Analyses below this confidence, or with uncertain policy, are marked “Requires review”.">
                  <input name="minConfidenceForAlert" type="number" min={0} max={1} step={0.05} defaultValue={settings.ai.minConfidenceForAlert} className="input w-32 tabular-nums" />
                </Field>
                <SubmitButton>Save AI behaviour</SubmitButton>
              </form>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="SLA & business hours" subtitle="Response delays are measured only inside business hours. Conversations are not flagged merely because a reply is pending within SLA." />
            <CardBody>
              <form action={saveSlaAction} className="space-y-3">
                <Field label="Time zone"><input name="timezone" defaultValue={settings.timezone} className="input" /></Field>
                <div>
                  <span className="label">Business days</span>
                  <div className="flex flex-wrap gap-3">
                    {DAY_LABELS.map((d, k) => <label key={d} className="flex items-center gap-1 text-sm"><input type="checkbox" name="days" value={k} defaultChecked={settings.businessHours.days.includes(k)} /> {d}</label>)}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Opens"><input name="start" type="time" defaultValue={settings.businessHours.start} className="input" /></Field>
                  <Field label="Closes"><input name="end" type="time" defaultValue={settings.businessHours.end} className="input" /></Field>
                </div>
                <div>
                  <span className="label">First-response SLA (business minutes)</span>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {CHANNELS.map((c) => (
                      <label key={c} className="block"><span className="text-2xs text-ink-muted">{CHANNEL_LABELS[c]}</span>
                        <input name={`frm_${c}`} type="number" min={0} max={10080} defaultValue={(settings.sla.firstResponseMinutes as Record<string, number>)[c] ?? 0} className="input tabular-nums" /></label>
                    ))}
                  </div>
                </div>
                <Field label="Resolution SLA (business hours)" hint="An open complaint waiting longer than this raises a “Complaint unresolved beyond SLA” alert."><input name="resolutionHours" type="number" min={0} max={720} defaultValue={settings.sla.resolutionHours} className="input w-32 tabular-nums" /></Field>
                <SubmitButton>Save SLA settings</SubmitButton>
              </form>
            </CardBody>
          </Card>
        </div>
      )}

      {tab === 'processing' && 'byStatus' in data && (
        <ProcessingPanel data={data as any} searchParams={searchParams} canRetry={can(s, 'processing.retry')} />
      )}
    </div>
  );
}

function CategoryRename({ c, compact }: { c: any; compact?: boolean }) {
  return (
    <form action={updateCategoryAction} className="flex items-center gap-1.5">
      <input type="hidden" name="id" value={c.id} />
      <input type="hidden" name="op" value="rename" />
      <input name="name" defaultValue={c.name} required maxLength={120} className={clsx('input', compact ? 'h-7 text-[13px]' : 'h-8')} aria-label={`Rename ${c.code}`} />
      <SubmitButton variant="ghost" size="sm">Rename</SubmitButton>
    </form>
  );
}

function CategoryToggle({ c }: { c: any }) {
  return (
    <form action={updateCategoryAction}>
      <input type="hidden" name="id" value={c.id} />
      <input type="hidden" name="name" value={c.name} />
      <input type="hidden" name="op" value={c.is_active ? 'deactivate' : 'activate'} />
      <SubmitButton variant="ghost" size="sm" confirm={c.is_active ? `Deactivate "${c.name}"? Existing labels are kept; the AI will stop using it.` : undefined}>
        {c.is_active ? 'Deactivate' : 'Reactivate'}
      </SubmitButton>
    </form>
  );
}

function ProcessingPanel({ data, searchParams, canRetry }: { data: { byStatus: any[]; interactions: any[]; failed: any[]; recent: any[] }; searchParams: SP; canRetry: boolean }) {
  const types = Array.from(new Set(data.byStatus.map((r) => r.type)));
  const statuses = ['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled'];
  const cell = (t: string, st: string) => data.byStatus.find((r) => r.type === t && r.status === st)?.n ?? 0;
  const preview = sp(searchParams, 'preview');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const monthAgo = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(daysFromNow(-30));
  const f = { from: sp(searchParams, 'from') ?? monthAgo, to: sp(searchParams, 'to') ?? today, channel: sp(searchParams, 'channel') ?? '', which: sp(searchParams, 'which') ?? 'all' };
  const deadCount = data.byStatus.filter((r) => r.status === 'dead' || r.status === 'failed').reduce((a, r) => a + r.n, 0);
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Job queue" subtitle="Background jobs by type and status (Postgres queue processed by the worker)." />
          {types.length ? (
            <Table>
              <THead><tr><th className="th">Type</th>{statuses.map((st) => <th key={st} className="th text-right">{titleCase(st)}</th>)}</tr></THead>
              <TBody>
                {types.map((t) => (
                  <tr key={t}><td className="td font-medium">{titleCase(t)}</td>
                    {statuses.map((st) => { const n = cell(t, st); return <td key={st} className={clsx('td text-right tabular-nums', n && (st === 'dead' ? 'font-semibold text-red-700' : st === 'failed' ? 'text-amber-700' : ''), !n && 'text-ink-faint')}>{n}</td>; })}
                  </tr>
                ))}
              </TBody>
            </Table>
          ) : <CardBody><p className="text-sm text-ink-muted">No jobs yet.</p></CardBody>}
        </Card>
        <Card>
          <CardHeader title="Interactions by processing status" />
          <CardBody className="grid grid-cols-2 gap-2">
            {data.interactions.sort((a, b) => b.n - a.n).map((r) => (
              <Link key={r.processing_status} href={`/inbox?processing=${r.processing_status}`} className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm hover:border-brand-500/40">
                <span>{PROCESSING_LABELS[r.processing_status] ?? r.processing_status}</span><span className="tabular-nums font-medium">{r.n}</span>
              </Link>
            ))}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Failed & dead jobs" subtitle="Dead = retries exhausted or a permanent error (e.g. recording no longer available). Retrying resets attempts."
          actions={canRetry && deadCount > 0 ? (
            <form action={retryJobAction}><input type="hidden" name="id" value="all-dead" /><SubmitButton variant="secondary" size="sm" confirm={`Re-queue up to 200 failed/dead jobs?`}>Retry all</SubmitButton></form>
          ) : undefined} />
        {data.failed.length ? (
          <Table>
            <THead><tr><th className="th">Job</th><th className="th">Interaction</th><th className="th">Status</th><th className="th">Attempts</th><th className="th">Error</th><th className="th">Updated</th><th className="th"></th></tr></THead>
            <TBody>
              {data.failed.map((j) => (
                <tr key={j.id}>
                  <td className="td"><p className="font-medium">{titleCase(j.type)}</p><p className="font-mono text-2xs text-ink-faint">{j.id.slice(0, 8)}</p></td>
                  <td className="td">{j.interaction_id ? <Link className="link" href={`/inbox/${j.interaction_id}`}>{j.ref}</Link> : '—'}{j.is_demo && <Badge tone="warn" className="ml-1">Demo</Badge>}</td>
                  <td className="td"><Badge tone={j.status === 'dead' ? 'bad' : 'warn'}>{j.status === 'queued' ? 'Retrying' : titleCase(j.status)}</Badge>{j.status === 'queued' && <p className="text-2xs text-ink-faint">next {relTime(j.run_after)}</p>}</td>
                  <td className="td tabular-nums">{j.attempts}/{j.max_attempts}</td>
                  <td className="td max-w-md text-xs text-ink-muted">{j.last_error ?? '—'}</td>
                  <td className="td whitespace-nowrap text-xs" title={fmtDateTime(j.updated_at)}>{relTime(j.updated_at)}</td>
                  <td className="td">{canRetry && j.status !== 'queued' && <form action={retryJobAction}><input type="hidden" name="id" value={j.id} /><SubmitButton variant="secondary" size="sm">Retry</SubmitButton></form>}</td>
                </tr>
              ))}
            </TBody>
          </Table>
        ) : <CardBody><p className="text-sm text-ink-muted">No failed jobs.</p></CardBody>}
      </Card>

      <Card id="reprocess">
        <CardHeader title="Reprocess after a model or policy change" subtitle="Re-runs AI analysis (and transcription where no transcript exists) for a filtered set. Current human evaluations are kept as the current score; the new AI evaluation is stored alongside." />
        <CardBody className="space-y-3">
          <form action={reprocessAction} className="grid gap-3 md:grid-cols-[10rem_10rem_10rem_14rem_auto] md:items-end">
            <Field label="From"><input name="from" type="date" defaultValue={f.from} required className="input" /></Field>
            <Field label="To"><input name="to" type="date" defaultValue={f.to} required className="input" /></Field>
            <Field label="Channel">
              <select name="channel" defaultValue={f.channel} className="input"><option value="">All channels</option>{CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}</select>
            </Field>
            <Field label="Which interactions">
              <select name="which" defaultValue={f.which} className="input">
                <option value="all">All in range</option><option value="not_human_reviewed">Not yet human-reviewed</option>
                <option value="requires_review">Requires review</option><option value="failed">Failed</option>
              </select>
            </Field>
            <SubmitButton variant="secondary" size="md">Preview count</SubmitButton>
          </form>
          {preview !== undefined && (
            Number(preview) === 0 ? <Notice tone="info">No interactions match this filter.</Notice> : (
              <Notice tone={Number(preview) > 500 ? 'bad' : 'warn'} title={`${preview} interaction${preview === '1' ? '' : 's'} match`}>
                {Number(preview) > 500 ? 'That is more than the 500-per-run limit. Narrow the date range or channel.' : (
                  <form action={reprocessAction} className="mt-2 flex flex-wrap items-center gap-2">
                    {Object.entries(f).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
                    <input type="hidden" name="confirm" value="yes" />
                    <span>Re-analysis uses the AI provider and may incur API costs.</span>
                    <SubmitButton variant="primary" size="sm" confirm={`Queue ${preview} interactions for re-analysis?`}>Confirm & queue {preview}</SubmitButton>
                  </form>
                )}
              </Notice>
            )
          )}
        </CardBody>
      </Card>
    </>
  );
}
