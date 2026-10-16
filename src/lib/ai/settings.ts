import type { Db } from '@/lib/db';
import { DEFAULT_ORG_SETTINGS, type OrgSettings } from '@/lib/constants';

/**
 * Org settings merge usable from the worker (session.ts is 'server-only' and cannot be imported by scripts).
 * Mirrors mergeSettings() in src/lib/auth/session.ts.
 */
export function mergeOrgSettings(s: Partial<OrgSettings> | null | undefined): OrgSettings {
  const d = DEFAULT_ORG_SETTINGS;
  const v = (s ?? {}) as any;
  return {
    ...d, ...v,
    businessHours: { ...d.businessHours, ...(v.businessHours ?? {}) },
    sla: { ...d.sla, ...(v.sla ?? {}), firstResponseMinutes: { ...d.sla.firstResponseMinutes, ...(v.sla?.firstResponseMinutes ?? {}) } },
    rubric: { default: { ...d.rubric.default, ...(v.rubric?.default ?? {}) }, overrides: v.rubric?.overrides ?? {} },
    retention: { ...d.retention, ...(v.retention ?? {}) },
    ai: { ...d.ai, ...(v.ai ?? {}) },
    notifications: { ...d.notifications, ...(v.notifications ?? {}) },
    scoreBands: Array.isArray(v.scoreBands) && v.scoreBands.length ? v.scoreBands : d.scoreBands,
  };
}

export async function loadOrgSettings(db: Db, orgId: string): Promise<OrgSettings> {
  const row = await db.one<{ settings: any }>('SELECT settings FROM organizations WHERE id = $1', [orgId]);
  return mergeOrgSettings(row?.settings);
}

/**
 * Deep-merge a patch into organizations.settings without clobbering unrelated keys.
 * Uses jsonb concatenation at the top level after merging the touched sub-objects in JS.
 */
export async function patchOrgSettings(db: Db, orgId: string, patch: Record<string, unknown>) {
  const row = await db.one<{ settings: any }>('SELECT settings FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
  const cur = (row?.settings ?? {}) as Record<string, any>;
  const next: Record<string, any> = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && cur[k] && typeof cur[k] === 'object' && !Array.isArray(cur[k])) next[k] = deepMerge(cur[k], v as any);
    else next[k] = v;
  }
  await db.exec('UPDATE organizations SET settings = $2 WHERE id = $1', [orgId, JSON.stringify(next)]);
  return next;
}

function deepMerge(a: Record<string, any>, b: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v;
  }
  return out;
}
