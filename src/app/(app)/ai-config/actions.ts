'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { assertPermission, auditAction } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { CHANNELS, RUBRIC_GROUPS, SEVERITIES, type RubricGroup } from '@/lib/constants';
import { patchOrgSettings, loadOrgSettings } from '@/lib/ai/settings';
import { enqueueProcessing, retryJob } from '@/lib/pipeline/jobs';

const REPROCESS_CAP = 500;

function back(tab: string, params: Record<string, string> = {}): never {
  const q = new URLSearchParams({ tab, ...params });
  revalidatePath('/ai-config');
  redirect(`/ai-config?${q.toString()}`);
}

async function guard<T>(tab: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e: any) {
    if (e?.digest?.startsWith?.('NEXT_REDIRECT')) throw e;
    const msg = e instanceof z.ZodError ? e.issues.map((i) => i.message).join('; ') : (e?.message ?? 'Something went wrong');
    back(tab, { error: msg.slice(0, 300) });
  }
}

const bool = (v: FormDataEntryValue | null) => v === 'on' || v === 'true' || v === '1';
const channelsFrom = (fd: FormData) => fd.getAll('channels').map(String).filter((c) => (CHANNELS as readonly string[]).includes(c));

// ───────────────────────── Rubric weights ─────────────────────────
export async function saveWeightsAction(fd: FormData) {
  const tab = 'rubric';
  await guard(tab, async () => {
    const s = await assertPermission('ai_config.manage');
    const scope = String(fd.get('scope') ?? 'default');
    if (scope !== 'default' && !(CHANNELS as readonly string[]).includes(scope)) throw new Error('Unknown channel');
    const inherit = scope !== 'default' && bool(fd.get('inherit'));
    const weights = {} as Record<RubricGroup, number>;
    for (const g of RUBRIC_GROUPS) {
      const n = Number(fd.get(`w_${g}`));
      if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error(`Weight for ${g} must be a whole number 0–100.`);
      weights[g] = n;
    }
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    if (!inherit && sum !== 100) throw new Error(`Weights must add up to 100 (currently ${sum}).`);
    await withOrg(s.org.id, async (db) => {
      const cur = await loadOrgSettings(db, s.org.id);
      const overrides = { ...(cur.rubric.overrides ?? {}) } as Record<string, unknown>;
      let rubric: Record<string, unknown>;
      if (scope === 'default') rubric = { default: weights, overrides };
      else {
        if (inherit) delete overrides[scope]; else overrides[scope] = weights;
        rubric = { default: cur.rubric.default, overrides };
      }
      // rubric replaced as a unit (so removed overrides really disappear); other settings keys untouched
      await db.exec(`UPDATE organizations SET settings = jsonb_set(settings, '{rubric}', $2::jsonb, true) WHERE id = $1`, [s.org.id, JSON.stringify(rubric)]);
      await auditAction(db, s, 'ai_config.weights', 'organization', s.org.id, { scope, weights: inherit ? 'inherit default' : weights });
    });
  });
  back(tab, { ok: 'Rubric weights saved. New analyses use them; reprocess to re-score older interactions.' });
}

// ───────────────────────── Criteria ─────────────────────────
const criterionSchema = z.object({
  code: z.string().min(1).max(80),
  name: z.string().trim().min(2, 'Name is required').max(120),
  description: z.string().trim().min(5, 'Description is required').max(1000),
});
export async function updateCriterionAction(fd: FormData) {
  const tab = 'rubric';
  await guard(tab, async () => {
    const s = await assertPermission('ai_config.manage');
    const v = criterionSchema.parse({ code: fd.get('code'), name: fd.get('name'), description: fd.get('description') });
    const channels = channelsFrom(fd);
    if (!channels.length) throw new Error('Select at least one channel for the criterion (or disable it).');
    const active = bool(fd.get('is_active'));
    await withOrg(s.org.id, async (db) => {
      const before = await db.one('SELECT name, description, channels, is_active FROM quality_criteria WHERE code = $1', [v.code]);
      if (!before) throw new Error('Criterion not found');
      await db.exec(`UPDATE quality_criteria SET name = $2, description = $3, channels = $4, is_active = $5 WHERE code = $1`, [v.code, v.name, v.description, channels, active]);
      await auditAction(db, s, 'ai_config.criterion', 'quality_criteria', v.code, { before, after: { name: v.name, description: v.description, channels, is_active: active } });
    });
  });
  back(tab, { ok: 'Criterion updated.' });
}

// ───────────────────────── Bands ─────────────────────────
export async function saveBandsAction(fd: FormData) {
  const tab = 'rubric';
  await guard(tab, async () => {
    const s = await assertPermission('ai_config.manage');
    const labels = fd.getAll('band_label').map(String), mins = fd.getAll('band_min').map(String), tones = fd.getAll('band_tone').map(String);
    const bands = labels.map((l, k) => ({ label: l.trim(), min: Number(mins[k]), tone: ['good', 'warn', 'bad'].includes(tones[k]) ? tones[k] : 'warn' }))
      .filter((b) => b.label);
    if (bands.length < 2) throw new Error('Define at least two score bands.');
    for (const b of bands) if (!Number.isFinite(b.min) || b.min < 0 || b.min > 100) throw new Error(`Band "${b.label}" needs a minimum between 0 and 100.`);
    if (new Set(bands.map((b) => b.min)).size !== bands.length) throw new Error('Band minimums must be unique.');
    if (!bands.some((b) => b.min === 0)) throw new Error('One band must start at 0 so every score has a band.');
    bands.sort((a, b) => b.min - a.min);
    const threshold = Number(fd.get('reviewThreshold'));
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error('Review threshold must be 0–100.');
    await withOrg(s.org.id, async (db) => {
      await db.exec(`UPDATE organizations SET settings = jsonb_set(settings, '{scoreBands}', $2::jsonb, true) WHERE id = $1`, [s.org.id, JSON.stringify(bands)]);
      await patchOrgSettings(db, s.org.id, { reviewThreshold: threshold });
      await auditAction(db, s, 'ai_config.bands', 'organization', s.org.id, { bands, reviewThreshold: threshold });
    });
  });
  back(tab, { ok: 'Score bands saved. Existing scores keep their stored band until reprocessed.' });
}

// ───────────────────────── Alert rules ─────────────────────────
export async function updateRuleAction(fd: FormData) {
  const tab = 'alerts';
  await guard(tab, async () => {
    const s = await assertPermission('ai_config.manage');
    const code = String(fd.get('code') ?? '');
    const severity = String(fd.get('severity') ?? '');
    if (!(SEVERITIES as readonly string[]).includes(severity)) throw new Error('Invalid severity');
    const minConf = Number(fd.get('min_confidence'));
    if (!Number.isFinite(minConf) || minConf < 0 || minConf > 1) throw new Error('Minimum confidence must be between 0 and 1.');
    const channels = channelsFrom(fd);
    const active = bool(fd.get('is_active'));
    if (active && !channels.length) throw new Error('An active rule needs at least one channel.');
    await withOrg(s.org.id, async (db) => {
      const before = await db.one('SELECT severity, min_confidence, channels, is_active FROM alert_rules WHERE code = $1', [code]);
      if (!before) throw new Error('Rule not found');
      await db.exec(`UPDATE alert_rules SET severity = $2, min_confidence = $3, channels = $4, is_active = $5 WHERE code = $1`, [code, severity, minConf, channels, active]);
      await auditAction(db, s, 'ai_config.alert_rule', 'alert_rules', code, { before, after: { severity, min_confidence: minConf, channels, is_active: active } });
    });
  });
  back(tab, { ok: 'Alert rule updated.' });
}

// ───────────────────────── Taxonomy ─────────────────────────
const slug = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Code must be lowercase letters, digits or _ (2–40 chars)');
export async function addCategoryAction(fd: FormData) {
  const tab = 'taxonomy';
  await guard(tab, async () => {
    const s = await assertPermission('ai_config.manage');
    const parentId = String(fd.get('parent_id') ?? '');
    const code = slug.parse(fd.get('code'));
    const name = z.string().trim().min(2, 'Name is required').max(120).parse(fd.get('name'));
    await withOrg(s.org.id, async (db) => {
      let fullCode = code, parent: { id: string; code: string } | null = null;
      if (parentId) {
        parent = await db.one<{ id: string; code: string }>('SELECT id, code FROM issue_categories WHERE id = $1 AND parent_id IS NULL', [parentId]);
        if (!parent) throw new Error('Parent category not found');
        fullCode = `${parent.code}.${code}`;
      }
      if (await db.one('SELECT 1 FROM issue_categories WHERE code = $1', [fullCode])) throw new Error(`Code "${fullCode}" already exists (codes are permanent; reactivate it instead).`);
      const sort = await db.one<{ n: number }>('SELECT coalesce(max(sort),0)+1 AS n FROM issue_categories WHERE parent_id IS NOT DISTINCT FROM $1', [parent?.id ?? null]);
      await db.exec('INSERT INTO issue_categories (org_id, parent_id, code, name, sort) VALUES ($1,$2,$3,$4,$5)', [s.org.id, parent?.id ?? null, fullCode, name, sort?.n ?? 0]);
      await auditAction(db, s, 'ai_config.taxonomy_add', 'issue_categories', fullCode, { name, parent: parent?.code ?? null });
    });
  });
  back(tab, { ok: 'Category added.' });
}

export async function updateCategoryAction(fd: FormData) {
  const tab = 'taxonomy';
  await guard(tab, async () => {
    const s = await assertPermission('ai_config.manage');
    const id = z.string().uuid().parse(fd.get('id'));
    const name = z.string().trim().min(2, 'Name is required').max(120).parse(fd.get('name'));
    const op = String(fd.get('op') ?? 'rename');
    await withOrg(s.org.id, async (db) => {
      const before = await db.one<{ code: string; name: string; is_active: boolean }>('SELECT code, name, is_active FROM issue_categories WHERE id = $1', [id]);
      if (!before) throw new Error('Category not found');
      if (op === 'deactivate' || op === 'activate') {
        await db.exec('UPDATE issue_categories SET is_active = $2 WHERE id = $1', [id, op === 'activate']);
        await auditAction(db, s, `ai_config.taxonomy_${op}`, 'issue_categories', before.code, {});
      } else {
        await db.exec('UPDATE issue_categories SET name = $2 WHERE id = $1', [id, name]);
        await auditAction(db, s, 'ai_config.taxonomy_rename', 'issue_categories', before.code, { from: before.name, to: name });
      }
    });
  });
  back(tab, { ok: 'Taxonomy updated. Existing labels keep their category; new analyses use the active taxonomy.' });
}

// ───────────────────────── AI behaviour, SLA & business hours ─────────────────────────
export async function saveBehaviourAction(fd: FormData) {
  const tab = 'behaviour';
  await guard(tab, async () => {
    const s = await assertPermission('ai_config.manage');
    const minConf = Number(fd.get('minConfidenceForAlert'));
    if (!Number.isFinite(minConf) || minConf < 0 || minConf > 1) throw new Error('Minimum confidence must be between 0 and 1.');
    const ai = { autoAnalyze: bool(fd.get('autoAnalyze')), translateToEnglish: bool(fd.get('translateToEnglish')), minConfidenceForAlert: minConf };
    await withOrg(s.org.id, async (db) => {
      await patchOrgSettings(db, s.org.id, { ai });
      await auditAction(db, s, 'ai_config.behaviour', 'organization', s.org.id, ai);
    });
  });
  back(tab, { ok: 'AI behaviour saved.' });
}

export async function saveSlaAction(fd: FormData) {
  const tab = 'behaviour';
  await guard(tab, async () => {
    const s = await assertPermission('ai_config.manage');
    const tz = String(fd.get('timezone') ?? 'Asia/Kolkata');
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw new Error('Unknown time zone'); }
    const days = fd.getAll('days').map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    const start = String(fd.get('start') ?? ''), end = String(fd.get('end') ?? '');
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || start >= end) throw new Error('Business hours need a valid start before end (HH:MM).');
    if (!days.length) throw new Error('Select at least one business day.');
    const frm: Record<string, number> = {};
    for (const c of CHANNELS) {
      const n = Number(fd.get(`frm_${c}`));
      if (!Number.isFinite(n) || n < 0 || n > 10080) throw new Error(`First-response SLA for ${c} must be 0–10080 minutes.`);
      frm[c] = Math.round(n);
    }
    const resolutionHours = Number(fd.get('resolutionHours'));
    if (!Number.isFinite(resolutionHours) || resolutionHours < 0 || resolutionHours > 720) throw new Error('Resolution SLA must be 0–720 hours.');
    const patch = { timezone: tz, businessHours: { days: Array.from(new Set(days)).sort(), start, end }, sla: { firstResponseMinutes: frm, resolutionHours } };
    await withOrg(s.org.id, async (db) => {
      await patchOrgSettings(db, s.org.id, patch);
      await auditAction(db, s, 'ai_config.sla', 'organization', s.org.id, patch);
    });
  });
  back(tab, { ok: 'SLA and business hours saved.' });
}

// ───────────────────────── Reprocess ─────────────────────────
function reprocessFilter(fd: FormData) {
  const from = String(fd.get('from') ?? ''), to = String(fd.get('to') ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new Error('Choose a valid date range.');
  const channel = String(fd.get('channel') ?? '');
  const which = String(fd.get('which') ?? 'all');
  const params: unknown[] = [`${from}T00:00:00+05:30`, `${to}T23:59:59.999+05:30`];
  let where = `i.occurred_at BETWEEN $1 AND $2 AND NOT (i.channel = 'call' AND EXISTS (SELECT 1 FROM calls c WHERE c.interaction_id = i.id AND c.call_status <> 'answered'))`;
  if ((CHANNELS as readonly string[]).includes(channel)) { params.push(channel); where += ` AND i.channel = $${params.length}`; }
  if (which === 'failed') where += ` AND i.processing_status = 'failed'`;
  else if (which === 'requires_review') where += ` AND i.processing_status = 'requires_review'`;
  else if (which === 'not_human_reviewed') where += ` AND NOT EXISTS (SELECT 1 FROM quality_evaluations e WHERE e.interaction_id = i.id AND e.is_current AND e.evaluator_type = 'human')`;
  return { where, params, from, to, channel, which };
}

export async function reprocessAction(fd: FormData) {
  const tab = 'processing';
  const confirmed = fd.get('confirm') === 'yes';
  let result: Record<string, string> = {};
  await guard(tab, async () => {
    const s = await assertPermission('ai_config.manage');
    const f = reprocessFilter(fd);
    const echo = { from: f.from, to: f.to, channel: f.channel, which: f.which };
    await withOrg(s.org.id, async (db) => {
      const cnt = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM interactions i WHERE ${f.where}`, f.params);
      const n = cnt?.n ?? 0;
      if (!confirmed) { result = { ...echo, preview: String(n) }; return; }
      if (n > REPROCESS_CAP) throw new Error(`${n} interactions match — narrow the filter to ${REPROCESS_CAP} or fewer per run.`);
      const ids = await db.query<{ id: string }>(`SELECT i.id FROM interactions i WHERE ${f.where} ORDER BY i.occurred_at DESC LIMIT ${REPROCESS_CAP}`, f.params);
      let queued = 0;
      for (const r of ids) if (await enqueueProcessing(db, s.org.id, r.id, { force: true, reason: 'reprocess' })) queued++;
      await auditAction(db, s, 'ai_config.reprocess', 'interactions', null, { ...echo, matched: n, queued });
      result = { ok: `${queued} interaction${queued === 1 ? '' : 's'} queued for re-analysis${queued < n ? ` (${n - queued} already queued)` : ''}. The worker processes them in the background.` };
    });
  });
  back(tab, result);
}

export async function retryJobAction(fd: FormData) {
  const tab = 'processing';
  let msg = '';
  await guard(tab, async () => {
    const s = await assertPermission('processing.retry');
    const id = String(fd.get('id') ?? '');
    await withOrg(s.org.id, async (db) => {
      if (id === 'all-dead') {
        const ids = await db.query<{ id: string }>(`SELECT id FROM processing_jobs WHERE status IN ('dead','failed') ORDER BY created_at DESC LIMIT 200`);
        let n = 0;
        for (const j of ids) n += await retryJob(db, j.id);
        await auditAction(db, s, 'processing.retry_all', 'processing_jobs', null, { count: n });
        msg = `${n} job${n === 1 ? '' : 's'} re-queued.`;
      } else {
        z.string().uuid().parse(id);
        const n = await retryJob(db, id);
        if (!n) throw new Error('Job is not in a retryable state.');
        await auditAction(db, s, 'processing.retry', 'processing_jobs', id, {});
        msg = 'Job re-queued.';
      }
    });
  });
  back(tab, { ok: msg });
}
