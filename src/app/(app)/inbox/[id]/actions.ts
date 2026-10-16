'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { assertPermission, getSession, type Session } from '@/lib/auth/session';
import type { Permission } from '@/lib/auth/rbac';
import { withOrg } from '@/lib/db';
import {
  addIssueLabel, addReviewerNote, correctEvaluation, removeIssueLabel, retryInteractionProcessing, ReviewError, setRootCauseStatus,
  updateInteractionStatus,
} from '@/lib/repos/interactions';
import { RESOLUTION_STATUSES, REVIEW_STATUSES, SEVERITIES } from '@/lib/constants';
import type { ActionResult } from '@/components/interaction/types';

const uuid = z.string().uuid();
const note = z.string().trim().max(4000).optional().transform((v) => v || null);

async function assertAny(perms: Permission[]): Promise<Session> {
  const s = await getSession();
  if (!s || (s.user.mfaEnabled && !s.mfaVerified)) throw new ReviewError('Not signed in');
  if (!perms.some((p) => s.permissions.has(p))) throw new ReviewError('You do not have permission to do this.');
  return s;
}

async function run(id: string, fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn();
    revalidatePath(`/inbox/${id}`);
    return { ok: true, message: message || undefined };
  } catch (e) {
    if (e instanceof z.ZodError) return { ok: false, error: e.errors[0]?.message ?? 'Invalid input.' };
    if (e instanceof ReviewError || (e instanceof Error && /permission|signed in/i.test(e.message))) return { ok: false, error: e.message };
    console.error('[inbox action]', e);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}

export async function retryProcessingAction(_: ActionResult, fd: FormData): Promise<ActionResult> {
  const id = String(fd.get('interactionId') ?? '');
  return run(id, async () => {
    const s = await assertPermission('processing.retry');
    uuid.parse(id);
    await withOrg(s.org.id, (db) => retryInteractionProcessing(db, s, id));
    return 'Processing re-queued. The worker will pick it up shortly.';
  });
}

const statusSchema = z.object({
  interactionId: uuid,
  resolution: z.enum(RESOLUTION_STATUSES),
  review: z.enum(REVIEW_STATUSES),
  note,
});
export async function updateStatusAction(_: ActionResult, fd: FormData): Promise<ActionResult> {
  const id = String(fd.get('interactionId') ?? '');
  return run(id, async () => {
    const s = await assertAny(['evaluations.correct', 'flags.review']);
    const v = statusSchema.parse(Object.fromEntries(fd));
    await withOrg(s.org.id, (db) => updateInteractionStatus(db, s, v.interactionId, { resolution: v.resolution, review: v.review, note: v.note }));
    revalidatePath('/inbox');
    return 'Status updated.';
  });
}

const noteSchema = z.object({ interactionId: uuid, note: z.string().trim().min(2, 'Write a note first.').max(4000) });
export async function addNoteAction(_: ActionResult, fd: FormData): Promise<ActionResult> {
  const id = String(fd.get('interactionId') ?? '');
  return run(id, async () => {
    const s = await assertAny(['evaluations.correct', 'flags.review']);
    const v = noteSchema.parse(Object.fromEntries(fd));
    await withOrg(s.org.id, (db) => addReviewerNote(db, s, v.interactionId, v.note));
    return 'Note added.';
  });
}

const scoreValue = z.union([z.literal('na'), z.coerce.number().int().min(0).max(5)]);
export async function correctEvaluationAction(_: ActionResult, fd: FormData): Promise<ActionResult> {
  const id = String(fd.get('interactionId') ?? '');
  return run(id, async () => {
    const s = await assertPermission('evaluations.correct');
    uuid.parse(id);
    const notes = z.string().trim().min(5, 'Explain the correction in the reviewer notes (min 5 characters).').max(4000).parse(fd.get('notes'));
    const scores: { code: string; score: number | null; na: boolean; note?: string }[] = [];
    for (const [k, raw] of fd.entries()) {
      if (!k.startsWith('score:')) continue;
      const code = z.string().regex(/^[a-z0-9_]{1,60}$/).parse(k.slice(6));
      if (raw === '') continue;
      const v = scoreValue.parse(raw);
      const cnote = z.string().trim().max(1000).parse(fd.get(`note:${code}`) ?? '');
      scores.push({ code, score: v === 'na' ? null : v, na: v === 'na', note: cnote || undefined });
    }
    const r = await withOrg(s.org.id, (db) => correctEvaluation(db, s, id, { scores, notes }));
    revalidatePath('/inbox');
    return `Saved human assessment: ${r.overall === null ? 'no applicable criteria' : `${Math.round(r.overall)}/100`}${r.band ? ` (${r.band})` : ''}.`;
  });
}

const addLabelSchema = z.object({
  interactionId: uuid,
  categoryId: uuid,
  subcategoryId: z.union([uuid, z.literal('')]).optional().transform((v) => v || null),
  product: z.string().trim().max(120).optional().transform((v) => v || null),
  severity: z.union([z.enum(SEVERITIES), z.literal('')]).optional().transform((v) => v || null),
  customerReason: z.string().trim().max(1000).optional().transform((v) => v || null),
  note,
});
export async function addLabelAction(_: ActionResult, fd: FormData): Promise<ActionResult> {
  const id = String(fd.get('interactionId') ?? '');
  return run(id, async () => {
    const s = await assertPermission('evaluations.correct');
    const v = addLabelSchema.parse(Object.fromEntries(fd));
    await withOrg(s.org.id, (db) => addIssueLabel(db, s, v.interactionId, v));
    return 'Label added.';
  });
}

const removeLabelSchema = z.object({ interactionId: uuid, labelId: uuid, note });
export async function removeLabelAction(_: ActionResult, fd: FormData): Promise<ActionResult> {
  const id = String(fd.get('interactionId') ?? '');
  return run(id, async () => {
    const s = await assertPermission('evaluations.correct');
    const v = removeLabelSchema.parse(Object.fromEntries(fd));
    await withOrg(s.org.id, (db) => removeIssueLabel(db, s, v.interactionId, v.labelId, v.note));
    return 'Label removed (kept in history).';
  });
}

const rootCauseSchema = z.object({ interactionId: uuid, rootCauseId: uuid, status: z.enum(['confirmed', 'rejected', 'suspected']), note });
export async function rootCauseAction(_: ActionResult, fd: FormData): Promise<ActionResult> {
  const id = String(fd.get('interactionId') ?? '');
  return run(id, async () => {
    const s = await assertPermission('evaluations.correct');
    const v = rootCauseSchema.parse(Object.fromEntries(fd));
    await withOrg(s.org.id, (db) => setRootCauseStatus(db, s, v.interactionId, v.rootCauseId, v.status, v.note));
    return v.status === 'suspected' ? 'Root cause reset to suspected.' : `Root cause ${v.status}.`;
  });
}
