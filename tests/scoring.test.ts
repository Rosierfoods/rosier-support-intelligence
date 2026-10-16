import { describe, expect, it } from 'vitest';
import { bandFor, computeScore, defaultCriteriaDefs, weightsFor, type CriterionScore } from '@/lib/ai/scoring';
import { DEFAULT_GROUP_WEIGHTS, DEFAULT_SCORE_BANDS } from '@/lib/constants';

const defs = defaultCriteriaDefs();
const all = (score: number): CriterionScore[] => defs.map((d) => ({ code: d.code, score, na: false }));

describe('computeScore', () => {
  it('perfect and zero scores', () => {
    expect(computeScore(all(5), defs, DEFAULT_GROUP_WEIGHTS).overall).toBe(100);
    expect(computeScore(all(0), defs, DEFAULT_GROUP_WEIGHTS).overall).toBe(0);
  });

  it('N/A criteria do not penalise: a fully N/A group is excluded and the rest is normalised', () => {
    // all policy criteria N/A, everything else 5 → still 100
    const scores = defs.map((d) => d.group === 'policy' ? { code: d.code, score: null, na: true } : { code: d.code, score: 5, na: false });
    const r = computeScore(scores, defs, DEFAULT_GROUP_WEIGHTS);
    expect(r.overall).toBe(100);
    expect(r.groups.policy.applicable).toBe(false);
    expect(r.groups.policy.score).toBeNull();
  });

  it('partial N/A within a group averages only the applicable criteria', () => {
    // policy group: refund_replacement N/A, escalation N/A, sop_compliance 5, privacy 3 → mean 4 → 16/20
    const scores = defs.map((d) => {
      if (d.code === 'refund_replacement' || d.code === 'escalation') return { code: d.code, score: null, na: true };
      if (d.code === 'privacy') return { code: d.code, score: 3, na: false };
      return { code: d.code, score: 5, na: false };
    });
    const r = computeScore(scores, defs, DEFAULT_GROUP_WEIGHTS);
    expect(r.groups.policy.score).toBe(16);
    expect(r.overall).toBe(96); // (100 - 20 + 16)
  });

  it('clamps out-of-range scores and ignores unknown codes', () => {
    const r = computeScore([...all(9), { code: 'nope', score: 0, na: false }], defs, DEFAULT_GROUP_WEIGHTS);
    expect(r.overall).toBe(100);
  });

  it('returns null when nothing is applicable', () => {
    expect(computeScore(defs.map((d) => ({ code: d.code, score: null, na: true })), defs, DEFAULT_GROUP_WEIGHTS).overall).toBeNull();
  });
});

describe('weightsFor', () => {
  it('applies org default then per-channel overrides', () => {
    const settings = { rubric: { default: { ...DEFAULT_GROUP_WEIGHTS, communication: 30, closure: 0 }, overrides: { email: { accuracy: 30, policy: 10 } } } } as any;
    expect(weightsFor(settings, 'chat').communication).toBe(30);
    expect(weightsFor(settings, 'email').accuracy).toBe(30);
    expect(weightsFor(settings, 'email').policy).toBe(10);
    expect(weightsFor(settings, 'email').communication).toBe(30);
  });

  it('a zero-weight group is excluded from the score', () => {
    const w = { ...DEFAULT_GROUP_WEIGHTS, closure: 0 };
    const scores = defs.map((d) => ({ code: d.code, score: d.group === 'closure' ? 0 : 5, na: false }));
    expect(computeScore(scores, defs, w).overall).toBe(100);
  });

  it('override changes the overall score', () => {
    const scores = defs.map((d) => ({ code: d.code, score: d.group === 'communication' ? 0 : 5, na: false }));
    const base = computeScore(scores, defs, DEFAULT_GROUP_WEIGHTS).overall!;
    const heavy = computeScore(scores, defs, { ...DEFAULT_GROUP_WEIGHTS, communication: 50 }).overall!;
    expect(base).toBe(80);
    expect(heavy).toBeLessThan(base);
  });
});

describe('bandFor', () => {
  it('maps default bands', () => {
    expect(bandFor(95, DEFAULT_SCORE_BANDS)?.label).toBe('Excellent');
    expect(bandFor(90, DEFAULT_SCORE_BANDS)?.label).toBe('Excellent');
    expect(bandFor(89.99, DEFAULT_SCORE_BANDS)?.label).toBe('Good');
    expect(bandFor(70, DEFAULT_SCORE_BANDS)?.label).toBe('Needs improvement');
    expect(bandFor(12, DEFAULT_SCORE_BANDS)?.label).toBe('Requires review');
    expect(bandFor(null, DEFAULT_SCORE_BANDS)).toBeNull();
  });
  it('handles custom unsorted bands', () => {
    const bands = [{ min: 0, label: 'Low' }, { min: 85, label: 'High' }, { min: 60, label: 'Mid' }];
    expect(bandFor(86, bands)?.label).toBe('High');
    expect(bandFor(60, bands)?.label).toBe('Mid');
    expect(bandFor(59, bands)?.label).toBe('Low');
  });
});
