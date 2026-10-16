'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { assertPermission, auditAction, audit, requestMeta, type Session } from '@/lib/auth/session';
import { withOrg, type Db } from '@/lib/db';
import { clearDemoData, generateDemoData } from '@/lib/demo/generate';
import type { ActionResult } from '@/components/analytics/ActionForm';

const fail = (e: unknown): ActionResult => ({ ok: false, error: e instanceof z.ZodError ? e.issues[0]?.message ?? 'Check the form.' : (e as Error).message });

function validTimezone(tz: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Merge one top-level key of organizations.settings without clobbering the rest. */
async function mergeSettingsKey(db: Db, key: string, patch: Record<string, unknown>) {
  await db.exec(
    `UPDATE organizations SET settings = jsonb_set(settings, ARRAY[$1::text], coalesce(settings->$1, '{}'::jsonb) || $2::jsonb, true)`,
    [key, JSON.stringify(patch)]);
}

const orgSchema = z.object({
  name: z.string().trim().min(2, 'Organisation name is required.').max(120),
  timezone: z.string().trim().min(3).max(64).refine(validTimezone, 'Unknown time zone (use an IANA name such as Asia/Kolkata).'),
});

export async function saveOrganization(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await assertPermission('settings.manage');
    const v = orgSchema.parse(Object.fromEntries(fd));
    await withOrg(s.org.id, async (db) => {
      const before = await db.one<{ name: string; tz: string | null }>(`SELECT name, settings->>'timezone' AS tz FROM organizations`);
      await db.exec(`UPDATE organizations SET name = $1, settings = jsonb_set(settings, '{timezone}', to_jsonb($2::text), true)`, [v.name, v.timezone]);
      await auditAction(db, s, 'settings.organization', 'organization', s.org.id, { before, after: { name: v.name, tz: v.timezone } });
    });
    revalidatePath('/', 'layout');
    return { ok: true, message: 'Organisation details saved.' };
  } catch (e) { return fail(e); }
}

const days = (label: string, min: number) => z.coerce.number({ invalid_type_error: `${label}: enter a number of days.` }).int().min(min, `${label}: at least ${min} days.`).max(3650, `${label}: at most 3650 days.`);
const retentionSchema = z.object({
  recordingsDays: days('Recordings', 1), transcriptsDays: days('Transcripts', 7), messagesDays: days('Messages', 7),
  piiDays: days('Customer personal data', 7), auditDays: days('Audit logs', 90),
});

export async function saveRetention(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await assertPermission('settings.manage');
    const v = retentionSchema.parse(Object.fromEntries(fd));
    await withOrg(s.org.id, async (db) => {
      const before = await db.one<{ r: unknown }>(`SELECT settings->'retention' AS r FROM organizations`);
      await mergeSettingsKey(db, 'retention', v);
      await auditAction(db, s, 'settings.retention', 'organization', s.org.id, { before: before?.r ?? null, after: v });
    });
    revalidatePath('/settings');
    return { ok: true, message: 'Retention policy saved. The retention job applies it on its next run.' };
  } catch (e) { return fail(e); }
}

export async function saveNotifications(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await assertPermission('settings.manage');
    const emailCritical = fd.get('emailCritical') === 'on';
    await withOrg(s.org.id, async (db) => {
      await mergeSettingsKey(db, 'notifications', { emailCritical });
      await auditAction(db, s, 'settings.notifications', 'organization', s.org.id, { emailCritical });
    });
    revalidatePath('/settings');
    return { ok: true, message: 'Notification settings saved.' };
  } catch (e) { return fail(e); }
}

/** Audit after demo regeneration: the acting demo user may have been recreated with a new id. */
async function auditDemo(db: Db, s: Session, action: string, details: Record<string, unknown>) {
  const still = await db.one(`SELECT 1 FROM users WHERE id = $1`, [s.user.id]);
  if (still) return auditAction(db, s, action, 'organization', s.org.id, details);
  let meta = {};
  try { meta = await requestMeta(); } catch { /* ignore */ }
  return audit(db, s.org.id, null, action, 'organization', s.org.id, { ...details, actor_email: s.user.email, actor_recreated: true }, meta);
}

export async function resetDemo(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await assertPermission('demo.reset');
    if (String(fd.get('confirm') ?? '').trim() !== 'RESET DEMO DATA') throw new Error('Type RESET DEMO DATA to confirm.');
    const summary = await withOrg(s.org.id, async (db) => {
      const r = await generateDemoData(db, s.org.id, { password: process.env.DEMO_PASSWORD ?? 'RosierDemo@2026' });
      await auditDemo(db, s, 'demo.reset', { summary: r });
      return r;
    });
    revalidatePath('/', 'layout');
    return { ok: true, message: `Demo data regenerated: ${summary.interactions} interactions (${summary.calls} calls, ${summary.chats} chats, ${summary.emails} emails), ${summary.flags} alerts, ${summary.coaching} coaching plans. Demo accounts were recreated — if you are signed in with one, sign in again.` };
  } catch (e) { return fail(e); }
}

export async function removeDemo(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await assertPermission('demo.reset');
    if (String(fd.get('confirm') ?? '').trim() !== 'REMOVE DEMO DATA') throw new Error('Type REMOVE DEMO DATA to confirm.');
    await withOrg(s.org.id, async (db) => {
      const me = await db.one<{ is_demo: boolean }>(`SELECT is_demo FROM users WHERE id = $1`, [s.user.id]);
      if (me?.is_demo) throw new Error('You are signed in with a demo account, which would be deleted. Create a real Super Admin in Team Management, sign in with it, then remove demo data.');
      const admins = await db.one<{ c: number }>(`SELECT count(*)::int AS c FROM users WHERE role = 'super_admin' AND is_active AND NOT is_demo`);
      if (!admins?.c) throw new Error('No non-demo Super Admin exists — removing demo data would lock everyone out.');
      const before = await db.one(`SELECT (SELECT count(*) FROM interactions WHERE is_demo)::int AS interactions, (SELECT count(*) FROM users WHERE is_demo)::int AS users`);
      await clearDemoData(db, s.org.id);
      await auditAction(db, s, 'demo.remove', 'organization', s.org.id, { removed: before });
    });
    revalidatePath('/', 'layout');
    return { ok: true, message: 'All demo data removed.' };
  } catch (e) { return fail(e); }
}
