import type { Role } from '@/lib/constants';

export const PERMISSIONS = [
  'dashboard.view',
  'interactions.view',          // scoped by dataScope()
  'customer_pii.view',          // unmasked phone / email
  'recordings.play',
  'flags.review',               // acknowledge, mark under review / confirmed / false positive
  'flags.assign',               // assign reviewer, escalate, resolve
  'evaluations.correct',        // manual QA assessment / correct AI scores & labels
  'coaching.assign',
  'coaching.view_all',
  'reports.view',
  'reports.export',
  'kb.view',
  'kb.edit',
  'integrations.manage',
  'ai_config.manage',
  'team.manage',
  'audit.view',
  'settings.manage',
  'demo.reset',
  'processing.retry',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  'dashboard.view': 'View overview dashboard',
  'interactions.view': 'View interactions (within data scope)',
  'customer_pii.view': 'See unmasked customer phone/email',
  'recordings.play': 'Play call recordings',
  'flags.review': 'Review quality alerts',
  'flags.assign': 'Assign, escalate and resolve alerts',
  'evaluations.correct': 'Correct AI scores and labels',
  'coaching.assign': 'Assign coaching',
  'coaching.view_all': 'View all coaching plans',
  'reports.view': 'View reports & analytics',
  'reports.export': 'Export reports / CSV',
  'kb.view': 'View knowledge base',
  'kb.edit': 'Edit & publish knowledge base',
  'integrations.manage': 'Manage integrations & API keys',
  'ai_config.manage': 'Manage AI rubric, alerts, bands',
  'team.manage': 'Manage users and teams',
  'audit.view': 'View audit logs',
  'settings.manage': 'Manage system settings & retention',
  'demo.reset': 'Reset demo data',
  'processing.retry': 'Retry failed processing jobs',
};

const ALL = new Set<Permission>(PERMISSIONS);

export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Set<Permission>> = {
  super_admin: ALL,
  crm_manager: new Set<Permission>([
    'dashboard.view', 'interactions.view', 'customer_pii.view', 'recordings.play', 'flags.review', 'flags.assign',
    'evaluations.correct', 'coaching.assign', 'coaching.view_all', 'reports.view', 'reports.export', 'kb.view', 'kb.edit',
    'processing.retry', 'audit.view',
  ]),
  team_leader: new Set<Permission>([
    'dashboard.view', 'interactions.view', 'recordings.play', 'flags.review', 'flags.assign', 'coaching.assign',
    'coaching.view_all', 'reports.view', 'reports.export', 'kb.view',
  ]),
  quality_analyst: new Set<Permission>([
    'dashboard.view', 'interactions.view', 'recordings.play', 'flags.review', 'evaluations.correct', 'reports.view',
    'kb.view', 'processing.retry',
  ]),
  support_agent: new Set<Permission>(['interactions.view', 'kb.view']),
};

/** Which interactions a role may see: everything, their team's, or only their own. */
export type DataScope = 'all' | 'team' | 'own';
export function dataScopeFor(role: Role): DataScope {
  if (role === 'team_leader') return 'team';
  if (role === 'support_agent') return 'own';
  return 'all';
}

export function resolvePermissions(role: Role, overrides: { permission: string; allowed: boolean }[]): Set<Permission> {
  const set = new Set(DEFAULT_ROLE_PERMISSIONS[role]);
  if (role === 'super_admin') return set; // super admin cannot be locked out
  for (const o of overrides) {
    if (!(PERMISSIONS as readonly string[]).includes(o.permission)) continue;
    if (o.allowed) set.add(o.permission as Permission);
    else set.delete(o.permission as Permission);
  }
  return set;
}
