import { DEFAULT_CRITERIA, DEFAULT_GROUP_WEIGHTS, RUBRIC_GROUPS, type Channel, type OrgSettings, type RubricGroup } from '@/lib/constants';

/**
 * Rubric scoring.
 * - Each criterion is scored 0–5 by the evaluator, or marked N/A.
 * - Group score = mean(applicable criterion scores) / 5 × group weight.
 * - Overall = Σ applicable group scores / Σ applicable group weights × 100.
 *   Groups whose criteria are all N/A are excluded, so N/A never penalises the agent.
 */
export interface CriterionDef { code: string; name: string; group: RubricGroup; channels?: string[] }
export interface CriterionScore { code: string; score: number | null; na: boolean; evidence?: string; rationale?: string }

export function weightsFor(settings: Pick<OrgSettings, 'rubric'>, channel: Channel): Record<RubricGroup, number> {
  const base = { ...DEFAULT_GROUP_WEIGHTS, ...(settings.rubric?.default ?? {}) };
  const ov = settings.rubric?.overrides?.[channel] ?? {};
  return { ...base, ...ov } as Record<RubricGroup, number>;
}

export function computeScore(
  scores: CriterionScore[], criteria: CriterionDef[], weights: Record<RubricGroup, number>,
): { overall: number | null; groups: Record<string, { score: number | null; weight: number; applicable: boolean }> } {
  const byCode = new Map(criteria.map((c) => [c.code, c]));
  const groups: Record<string, { score: number | null; weight: number; applicable: boolean }> = {};
  let earned = 0, possible = 0;
  for (const g of RUBRIC_GROUPS) {
    const vals = scores
      .filter((s) => byCode.get(s.code)?.group === g && !s.na && typeof s.score === 'number')
      .map((s) => Math.max(0, Math.min(5, s.score as number)));
    const w = Number(weights[g] ?? 0);
    if (!vals.length || w <= 0) { groups[g] = { score: null, weight: w, applicable: false }; continue; }
    const gs = (vals.reduce((a, b) => a + b, 0) / vals.length / 5) * w;
    groups[g] = { score: round2(gs), weight: w, applicable: true };
    earned += gs; possible += w;
  }
  return { overall: possible > 0 ? round2((earned / possible) * 100) : null, groups };
}

export function bandFor(score: number | null | undefined, bands: readonly { min: number; label: string; tone?: string }[]) {
  if (score === null || score === undefined || Number.isNaN(score)) return null;
  const sorted = [...bands].sort((a, b) => b.min - a.min);
  return sorted.find((b) => score >= b.min) ?? sorted[sorted.length - 1];
}

export function defaultCriteriaDefs(): CriterionDef[] {
  return DEFAULT_CRITERIA.map((c) => ({ code: c.code, name: c.name, group: c.group, channels: c.channels }));
}

function round2(n: number) { return Math.round(n * 100) / 100; }
