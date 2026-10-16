'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { assertPermission, auditAction, getSession, type Session } from '@/lib/auth/session';
import { withOrg, type Db } from '@/lib/db';
import { SqlBuilder } from '@/lib/sql';
import { scopeAgents } from '@/lib/repos/scope';
import { notifyUsers } from '@/lib/notify';
import { agentUserIds, measureMetric } from '@/lib/repos/coaching';
import type { ActionResult } from '@/components/analytics/ActionForm';

const uuid = z.string().uuid();
const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : null));
const optNum = z.union([z.literal(''), z.coerce.number().min(0).max(100)]).optional().transform((v) => (v === '' || v === undefined ? null : v));

const createSchema = z.object({
  flagId: z.union([z.literal(''), uuid]).optional().transform((v) => v || null),
  agentId: z.union([z.literal(''), uuid]).optional().transform((v) => v || null),
  confirmFlag: z.literal('on').optional(),
  title: z.string().trim().min(3, 'Add a short title.').max(200),
  whatWentWrong: z.string().trim().min(3, 'Describe what went wrong.').max(4000),
  whyItMatters: z.string().trim().min(3, 'Explain why it matters.').max(4000),
  evidence: optText(4000),
  sopReference: optText(300),
  policyVersionId: z.union([z.literal(''), uuid]).optional().transform((v) => v || null),
  betterResponse: optText(4000),
  recommendedAction: optText(4000),
  exercise: optText(4000),
  reviewDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a review date.'),
  targetMetric: z.string().trim().min(1).max(60).regex(/^[a-z0-9_]+$/),
  targetValue: optNum,
  baselineValue: optNum,
  goal: optText(1000),
  source: z.enum(['ai', 'manual']).default('manual'),
});

async function sessionForAgentAction(): Promise<Session> {
  const s = await getSession();
  if (!s || (s.user.mfaEnabled && !s.mfaVerified)) throw new Error('Not signed in');
  return s;
}

async function agentInScope(db: Db, s: Session, agentId: string) {
  const b = new SqlBuilder();
  return db.one<{ id: string; name: string }>(`SELECT id, name FROM agents WHERE id = ${b.p(agentId)} AND ${scopeAgents(s, b, 'id')}`, b.params);
}

/** Step 3 of the workflow: manager assigns coaching (optionally from a human-verified flag). */
export async function createCoachingAction(_: ActionResult, fd: FormData): Promise<ActionResult> {
  let s: Session;
  try { s = await assertPermission('coaching.assign'); } catch (e: any) { return { ok: false, error: e.message }; }
  const parsed = createSchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form.' };
  const v = parsed.data;
  if (v.reviewDate < new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())) return { ok: false, error: 'The review date must be today or later.' };

  let newId: string;
  try {
    newId = await withOrg(s.org.id, async (db) => {
      let agentId = v.agentId;
      let interactionId: string | null = null;
      let flagStatusBefore: string | null = null;
      if (v.flagId) {
        const b = new SqlBuilder();
        const flag = await db.one<{ id: string; status: string; agent_id: string | null; interaction_id: string }>(
          `SELECT id, status, agent_id, interaction_id FROM quality_flags WHERE id = ${b.p(v.flagId)} AND ${scopeAgents(s, b, 'agent_id')} FOR UPDATE`, b.params);
        if (!flag) throw new Error('Quality alert not found or outside your scope.');
        if (!flag.agent_id) throw new Error('This alert has no agent attached, so coaching cannot be assigned from it.');
        const existing = await db.one(`SELECT id FROM coaching_actions WHERE flag_id = $1 AND status <> 'cancelled'`, [flag.id]);
        if (existing) throw new Error('Coaching has already been assigned for this alert.');
        flagStatusBefore = flag.status;
        if (flag.status === 'new') {
          // Human verification is required before coaching (workflow step 2).
          if (!v.confirmFlag) throw new Error('This alert has not been verified yet. Tick “I have reviewed the evidence” to confirm it, or review it in the quality queue first.');
          if (!s.permissions.has('flags.review')) throw new Error('You need permission to review alerts before confirming this one.');
          await db.exec(`UPDATE quality_flags SET status = 'confirmed', acknowledged_at = coalesce(acknowledged_at, now()) WHERE id = $1`, [flag.id]);
          await db.exec(
            `INSERT INTO reviewer_decisions (org_id, target_type, target_id, interaction_id, reviewer_id, decision, before_state, after_state, notes)
             VALUES ($1,'flag',$2,$3,$4,'confirm',$5,$6,$7)`,
            [s.org.id, flag.id, flag.interaction_id, s.user.id, JSON.stringify({ status: 'new' }), JSON.stringify({ status: 'confirmed' }), 'Confirmed while assigning coaching']);
          await auditAction(db, s, 'flag.confirm', 'quality_flag', flag.id, { via: 'coaching' });
          flagStatusBefore = 'confirmed';
        } else if (!['confirmed', 'under_review'].includes(flag.status)) {
          throw new Error(`Coaching can only be assigned for alerts that are under review or confirmed (this one is “${flag.status.replace('_', ' ')}”).`);
        }
        agentId = flag.agent_id;
        interactionId = flag.interaction_id;
      }
      if (!agentId) throw new Error('Choose an agent.');
      const agent = await agentInScope(db, s, agentId);
      if (!agent) throw new Error('Agent not found or outside your scope.');

      const ca = await db.one<{ id: string }>(
        `INSERT INTO coaching_actions (org_id, agent_id, flag_id, interaction_id, title, what_went_wrong, why_it_matters, evidence, sop_reference,
            policy_version_id, better_response, recommended_action, exercise, review_date, target_metric, target_value, baseline_value, source, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'assigned',$19) RETURNING id`,
        [s.org.id, agentId, v.flagId, interactionId, v.title, v.whatWentWrong, v.whyItMatters, v.evidence, v.sopReference,
          v.policyVersionId, v.betterResponse, v.recommendedAction, v.exercise, v.reviewDate, v.targetMetric, v.targetValue, v.baselineValue,
          v.flagId ? v.source : 'manual', s.user.id]);
      await db.exec(
        `INSERT INTO coaching_assignments (org_id, coaching_action_id, agent_id, assigned_by, goal) VALUES ($1,$2,$3,$4,$5)`,
        [s.org.id, ca!.id, agentId, s.user.id, v.goal]);
      if (v.flagId) {
        await db.exec(`UPDATE quality_flags SET status = 'coaching_assigned' WHERE id = $1`, [v.flagId]);
        await db.exec(
          `INSERT INTO reviewer_decisions (org_id, target_type, target_id, interaction_id, reviewer_id, decision, before_state, after_state, notes)
           VALUES ($1,'flag',$2,$3,$4,'coaching_assigned',$5,$6,$7)`,
          [s.org.id, v.flagId, interactionId, s.user.id, JSON.stringify({ status: flagStatusBefore }), JSON.stringify({ status: 'coaching_assigned', coaching_action_id: ca!.id }), v.title]);
      }
      await auditAction(db, s, 'coaching.assign', 'coaching_action', ca!.id, { agent_id: agentId, flag_id: v.flagId, source: v.flagId ? v.source : 'manual', target_metric: v.targetMetric });
      await notifyUsers(db, s.org.id, await agentUserIds(db, agentId), {
        type: 'coaching.assigned', title: 'New coaching assigned to you', body: v.title, link: `/coaching/${ca!.id}`,
      });
      return ca!.id;
    });
  } catch (e: any) {
    return { ok: false, error: e.message ?? 'Could not create the coaching plan.' };
  }
  revalidatePath('/coaching');
  redirect(`/coaching/${newId}`);
}

// ───────────────────────── Workflow transitions ─────────────────────────
const idSchema = z.object({ id: uuid, comment: z.string().trim().max(2000).optional() });

async function loadForAgent(db: Db, s: Session, id: string) {
  const row = await db.one<{ id: string; agent_id: string; status: string; title: string; assigned_by: string | null; assignment_id: string }>(
    `SELECT ca.id, ca.agent_id, ca.status, ca.title, asg.assigned_by, asg.id AS assignment_id
       FROM coaching_actions ca JOIN LATERAL (SELECT * FROM coaching_assignments x WHERE x.coaching_action_id = ca.id ORDER BY x.assigned_at DESC LIMIT 1) asg ON true
      WHERE ca.id = $1 FOR UPDATE OF ca`, [id]);
  if (!row) throw new Error('Coaching plan not found.');
  if (!s.user.agentId || row.agent_id !== s.user.agentId) throw new Error('Only the coached agent can update this step.');
  return row;
}

/** Steps 4–5: the agent acknowledges the feedback (optionally with a comment). */
export async function acknowledgeCoaching(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await sessionForAgentAction();
    const v = idSchema.parse(Object.fromEntries(fd));
    await withOrg(s.org.id, async (db) => {
      const r = await loadForAgent(db, s, v.id);
      if (r.status !== 'assigned') throw new Error('This plan has already been acknowledged.');
      await db.exec(`UPDATE coaching_actions SET status = 'acknowledged' WHERE id = $1`, [r.id]);
      await db.exec(`UPDATE coaching_assignments SET acknowledged_at = now(), agent_comment = $2 WHERE id = $1`, [r.assignment_id, v.comment || null]);
      await auditAction(db, s, 'coaching.acknowledge', 'coaching_action', r.id, { has_comment: !!v.comment });
      if (r.assigned_by) await notifyUsers(db, s.org.id, [r.assigned_by], { type: 'coaching.acknowledged', title: `${s.user.name} acknowledged coaching`, body: r.title, link: `/coaching/${r.id}` });
    });
  } catch (e: any) { return { ok: false, error: e.message }; }
  revalidatePath('/coaching', 'layout');
  return { ok: true, message: 'Thanks — your acknowledgement has been recorded.' };
}

export async function startCoaching(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await sessionForAgentAction();
    const v = idSchema.parse(Object.fromEntries(fd));
    await withOrg(s.org.id, async (db) => {
      const r = await loadForAgent(db, s, v.id);
      if (r.status !== 'acknowledged') throw new Error('Acknowledge the plan before starting it.');
      await db.exec(`UPDATE coaching_actions SET status = 'in_progress' WHERE id = $1`, [r.id]);
      await auditAction(db, s, 'coaching.start', 'coaching_action', r.id, {});
    });
  } catch (e: any) { return { ok: false, error: e.message }; }
  revalidatePath('/coaching', 'layout');
  return { ok: true, message: 'Marked as in progress.' };
}

export async function completeCoaching(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await sessionForAgentAction();
    const v = idSchema.parse(Object.fromEntries(fd));
    await withOrg(s.org.id, async (db) => {
      const r = await loadForAgent(db, s, v.id);
      if (!['acknowledged', 'in_progress'].includes(r.status)) throw new Error('This plan cannot be completed from its current status.');
      await db.exec(`UPDATE coaching_actions SET status = 'completed' WHERE id = $1`, [r.id]);
      await db.exec(`UPDATE coaching_assignments SET completed_at = now(), agent_comment = coalesce($2, agent_comment) WHERE id = $1`, [r.assignment_id, v.comment || null]);
      await auditAction(db, s, 'coaching.complete', 'coaching_action', r.id, {});
      if (r.assigned_by) await notifyUsers(db, s.org.id, [r.assigned_by], { type: 'coaching.completed', title: `${s.user.name} completed a coaching plan`, body: r.title, link: `/coaching/${r.id}` });
    });
  } catch (e: any) { return { ok: false, error: e.message }; }
  revalidatePath('/coaching', 'layout');
  return { ok: true, message: 'Marked as completed. Your manager will review the results.' };
}

async function loadForManager(db: Db, s: Session, id: string) {
  const b = new SqlBuilder();
  const row = await db.one<any>(
    `SELECT ca.*, asg.id AS assignment_id, asg.assigned_at FROM coaching_actions ca
       JOIN LATERAL (SELECT * FROM coaching_assignments x WHERE x.coaching_action_id = ca.id ORDER BY x.assigned_at DESC LIMIT 1) asg ON true
      WHERE ca.id = ${b.p(id)} AND ${scopeAgents(s, b, 'ca.agent_id')} FOR UPDATE OF ca`, b.params);
  if (!row) throw new Error('Coaching plan not found or outside your scope.');
  return row;
}

const goalSchema = z.object({
  id: uuid, goal: z.string().trim().min(3, 'Describe the goal.').max(1000),
  targetMetric: z.string().trim().min(1).max(60).regex(/^[a-z0-9_]+$/), targetValue: optNum,
  reviewDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
});

/** Step 6: manager sets / updates the improvement goal. */
export async function setCoachingGoal(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await assertPermission('coaching.assign');
    const v = goalSchema.parse(Object.fromEntries(fd));
    await withOrg(s.org.id, async (db) => {
      const r = await loadForManager(db, s, v.id);
      if (['reviewed', 'cancelled'].includes(r.status)) throw new Error('This plan is closed.');
      await db.exec(`UPDATE coaching_assignments SET goal = $2 WHERE id = $1`, [r.assignment_id, v.goal]);
      await db.exec(`UPDATE coaching_actions SET target_metric = $2, target_value = $3, review_date = coalesce($4::date, review_date) WHERE id = $1`,
        [r.id, v.targetMetric, v.targetValue, v.reviewDate || null]);
      await auditAction(db, s, 'coaching.set_goal', 'coaching_action', r.id, { target_metric: v.targetMetric, target_value: v.targetValue });
      await notifyUsers(db, s.org.id, await agentUserIds(db, r.agent_id), { type: 'coaching.goal', title: 'Your coaching goal was updated', body: v.goal, link: `/coaching/${r.id}` });
    });
  } catch (e: any) { return { ok: false, error: e instanceof z.ZodError ? e.issues[0]?.message : e.message }; }
  revalidatePath('/coaching', 'layout');
  return { ok: true, message: 'Goal saved.' };
}

const reviewSchema = z.object({ id: uuid, outcome: z.enum(['improved', 'no_change', 'worsened']), notes: z.string().trim().max(2000).optional() });

/** Steps 7–8: the platform measures performance since assignment; manager records the outcome. */
export async function reviewCoaching(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await assertPermission('coaching.assign');
    const v = reviewSchema.parse(Object.fromEntries(fd));
    await withOrg(s.org.id, async (db) => {
      const r = await loadForManager(db, s, v.id);
      if (!['completed', 'in_progress', 'acknowledged'].includes(r.status)) throw new Error('Only active or completed plans can be reviewed.');
      const measured = await measureMetric(db, r.agent_id, r.target_metric, new Date(r.assigned_at));
      await db.exec(`UPDATE coaching_actions SET status = 'reviewed' WHERE id = $1`, [r.id]);
      await db.exec(
        `UPDATE coaching_assignments SET reviewed_at = now(), reviewed_by = $2, outcome = $3, outcome_value = $4, outcome_notes = $5 WHERE id = $1`,
        [r.assignment_id, s.user.id, v.outcome, measured.value, v.notes || null]);
      if (r.flag_id) {
        const fl = await db.one<{ status: string; interaction_id: string }>(`SELECT status, interaction_id FROM quality_flags WHERE id = $1`, [r.flag_id]);
        if (fl?.status === 'coaching_assigned') {
          await db.exec(`UPDATE quality_flags SET status = 'resolved', resolved_at = now() WHERE id = $1`, [r.flag_id]);
          await db.exec(
            `INSERT INTO reviewer_decisions (org_id, target_type, target_id, interaction_id, reviewer_id, decision, before_state, after_state, notes)
             VALUES ($1,'flag',$2,$3,$4,'resolve',$5,$6,$7)`,
            [s.org.id, r.flag_id, fl.interaction_id, s.user.id, JSON.stringify({ status: 'coaching_assigned' }), JSON.stringify({ status: 'resolved' }), `Coaching reviewed: ${v.outcome}`]);
        }
      }
      await auditAction(db, s, 'coaching.review', 'coaching_action', r.id, { outcome: v.outcome, measured_value: measured.value, measured_n: measured.n, baseline: r.baseline_value });
      await notifyUsers(db, s.org.id, await agentUserIds(db, r.agent_id), { type: 'coaching.reviewed', title: 'Your coaching plan was reviewed', body: r.title, link: `/coaching/${r.id}` });
    });
  } catch (e: any) { return { ok: false, error: e instanceof z.ZodError ? e.issues[0]?.message : e.message }; }
  revalidatePath('/coaching', 'layout');
  return { ok: true, message: 'Review recorded.' };
}

export async function cancelCoaching(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await assertPermission('coaching.assign');
    const v = idSchema.parse(Object.fromEntries(fd));
    await withOrg(s.org.id, async (db) => {
      const r = await loadForManager(db, s, v.id);
      if (['reviewed', 'cancelled'].includes(r.status)) throw new Error('This plan is already closed.');
      await db.exec(`UPDATE coaching_actions SET status = 'cancelled' WHERE id = $1`, [r.id]);
      if (r.flag_id) {
        const n = await db.exec(`UPDATE quality_flags SET status = 'confirmed' WHERE id = $1 AND status = 'coaching_assigned'`, [r.flag_id]);
        if (n) {
          await db.exec(
            `INSERT INTO reviewer_decisions (org_id, target_type, target_id, interaction_id, reviewer_id, decision, before_state, after_state, notes)
             VALUES ($1,'flag',$2,$3,$4,'coaching_cancelled',$5,$6,$7)`,
            [s.org.id, r.flag_id, r.interaction_id, s.user.id, JSON.stringify({ status: 'coaching_assigned' }), JSON.stringify({ status: 'confirmed' }), v.comment || null]);
        }
      }
      await auditAction(db, s, 'coaching.cancel', 'coaching_action', r.id, { reason: v.comment || null });
    });
  } catch (e: any) { return { ok: false, error: e.message }; }
  revalidatePath('/coaching', 'layout');
  return { ok: true, message: 'Coaching plan cancelled.' };
}
