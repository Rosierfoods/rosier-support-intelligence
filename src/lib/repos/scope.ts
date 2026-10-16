import type { Session } from '@/lib/auth/session';
import type { SqlBuilder } from '@/lib/sql';

/**
 * Role-based data scope for interaction-level data.
 *   all  → super admin, CRM manager, quality analyst
 *   team → team leader (their team's interactions)
 *   own  → support agent (interactions assigned to their linked agent profile)
 * Org isolation is separately enforced by Postgres RLS.
 */
export function scopeInteractions(s: Session, b: SqlBuilder, alias = 'i'): string {
  if (s.scope === 'all') return 'TRUE';
  if (s.scope === 'team') return s.user.teamId ? `${alias}.team_id = ${b.p(s.user.teamId)}` : 'FALSE';
  return s.user.agentId ? `${alias}.agent_id = ${b.p(s.user.agentId)}` : 'FALSE';
}

/** Same scope for agent-keyed tables (flags, coaching, agents). */
export function scopeAgents(s: Session, b: SqlBuilder, agentIdExpr = 'agent_id'): string {
  if (s.scope === 'all') return 'TRUE';
  if (s.scope === 'team') return s.user.teamId ? `${agentIdExpr} IN (SELECT id FROM agents WHERE team_id = ${b.p(s.user.teamId)})` : 'FALSE';
  return s.user.agentId ? `${agentIdExpr} = ${b.p(s.user.agentId)}` : 'FALSE';
}

export function orgHasDemoData(rows: { is_demo?: boolean }[]) {
  return rows.some((r) => r.is_demo);
}
