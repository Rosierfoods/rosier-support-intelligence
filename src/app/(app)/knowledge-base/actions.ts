'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { assertPermission, auditAction } from '@/lib/auth/session';
import { withOrg, isUuid, type Db } from '@/lib/db';

const bool = (v: FormDataEntryValue | null) => v === 'on' || v === 'true' || v === '1';
const msgOf = (e: any) => (e instanceof z.ZodError ? e.issues.map((i) => i.message).join('; ') : e?.message ?? 'Something went wrong').slice(0, 300);
const isRedirect = (e: any) => typeof e?.digest === 'string' && e.digest.startsWith('NEXT_REDIRECT');

const articleSchema = z.object({
  title: z.string().trim().min(3, 'Title is required').max(200),
  category: z.string().trim().min(2, 'Category is required').max(60),
  body: z.string().trim().min(10, 'Article text is required').max(100_000),
  change_note: z.string().trim().max(500).optional().default(''),
});

async function publishVersion(db: Db, articleId: string, versionId: string, stillTemplate: boolean) {
  const v = await db.one<{ id: string; status: string; version: number }>('SELECT id, status, version FROM knowledge_base_versions WHERE id = $1 AND article_id = $2', [versionId, articleId]);
  if (!v) throw new Error('Version not found');
  if (v.status === 'published') throw new Error('This version is already published.');
  // previous published version(s) → superseded; older unpublished drafts are superseded too
  await db.exec(`UPDATE knowledge_base_versions SET status = 'superseded' WHERE article_id = $1 AND id <> $2 AND (status = 'published' OR (status = 'draft' AND version < $3))`, [articleId, versionId, v.version]);
  await db.exec(`UPDATE knowledge_base_versions SET status = 'published', published_at = now(), is_placeholder = $2 WHERE id = $1`, [versionId, stillTemplate]);
  await db.exec(`UPDATE knowledge_base_articles SET status = 'published', current_version_id = $2 WHERE id = $1`, [articleId, versionId]);
  return v.version;
}

export async function createArticleAction(fd: FormData) {
  let id = '';
  try {
    const s = await assertPermission('kb.edit');
    const v = articleSchema.parse({ title: fd.get('title'), category: fd.get('category'), body: fd.get('body'), change_note: fd.get('change_note') ?? '' });
    const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{2,80}$/, 'Slug: lowercase letters, digits and hyphens (3–80)').parse(fd.get('slug'));
    const publish = bool(fd.get('publish'));
    const stillTemplate = bool(fd.get('still_template'));
    id = await withOrg(s.org.id, async (db) => {
      if (await db.one('SELECT 1 FROM knowledge_base_articles WHERE slug = $1', [slug])) throw new Error(`An article with slug "${slug}" already exists.`);
      const a = await db.one<{ id: string }>(`INSERT INTO knowledge_base_articles (org_id, slug, title, category, status, updated_by) VALUES ($1,$2,$3,$4,'draft',$5) RETURNING id`,
        [s.org.id, slug, v.title, v.category, s.user.id]);
      const ver = await db.one<{ id: string }>(`INSERT INTO knowledge_base_versions (org_id, article_id, version, body, change_note, status, created_by, is_placeholder)
        VALUES ($1,$2,1,$3,$4,'draft',$5,$6) RETURNING id`, [s.org.id, a!.id, v.body, v.change_note || 'Initial version', s.user.id, stillTemplate]);
      if (publish) await publishVersion(db, a!.id, ver!.id, stillTemplate);
      await auditAction(db, s, 'kb.create', 'knowledge_base_article', a!.id, { slug, title: v.title, published: publish, placeholder: stillTemplate });
      return a!.id;
    });
  } catch (e) {
    if (isRedirect(e)) throw e;
    redirect(`/knowledge-base/new?error=${encodeURIComponent(msgOf(e))}`);
  }
  revalidatePath('/knowledge-base');
  redirect(`/knowledge-base/${id}?ok=${encodeURIComponent('Article created.')}`);
}

export async function saveDraftAction(fd: FormData) {
  const id = String(fd.get('article_id') ?? '');
  if (!isUuid(id)) redirect('/knowledge-base');
  let versionNo = 0;
  try {
    const s = await assertPermission('kb.edit');
    const v = articleSchema.parse({ title: fd.get('title'), category: fd.get('category'), body: fd.get('body'), change_note: fd.get('change_note') ?? '' });
    versionNo = await withOrg(s.org.id, async (db) => {
      const a = await db.one<{ id: string; title: string; category: string }>('SELECT id, title, category FROM knowledge_base_articles WHERE id = $1 FOR UPDATE', [id]);
      if (!a) throw new Error('Article not found');
      const next = await db.one<{ n: number }>('SELECT coalesce(max(version),0)+1 AS n FROM knowledge_base_versions WHERE article_id = $1', [id]);
      await db.exec(`INSERT INTO knowledge_base_versions (org_id, article_id, version, body, change_note, status, created_by, is_placeholder)
        VALUES ($1,$2,$3,$4,$5,'draft',$6,false)`, [s.org.id, id, next!.n, v.body, v.change_note || null, s.user.id]);
      await db.exec('UPDATE knowledge_base_articles SET title = $2, category = $3, updated_by = $4 WHERE id = $1', [id, v.title, v.category, s.user.id]);
      await auditAction(db, s, 'kb.draft', 'knowledge_base_article', id, { version: next!.n, title_changed: a.title !== v.title, category_changed: a.category !== v.category, change_note: v.change_note || null });
      return next!.n;
    });
  } catch (e) {
    if (isRedirect(e)) throw e;
    redirect(`/knowledge-base/${id}/edit?error=${encodeURIComponent(msgOf(e))}`);
  }
  revalidatePath(`/knowledge-base/${id}`);
  redirect(`/knowledge-base/${id}?ok=${encodeURIComponent(`Draft v${versionNo} saved. Review it and publish when approved.`)}`);
}

export async function publishAction(fd: FormData) {
  const id = String(fd.get('article_id') ?? ''), versionId = String(fd.get('version_id') ?? '');
  if (!isUuid(id) || !isUuid(versionId)) redirect('/knowledge-base');
  let msg = '';
  try {
    const s = await assertPermission('kb.edit');
    const stillTemplate = bool(fd.get('still_template'));
    await withOrg(s.org.id, async (db) => {
      const n = await publishVersion(db, id, versionId, stillTemplate);
      await auditAction(db, s, 'kb.publish', 'knowledge_base_article', id, { version_id: versionId, version: n, placeholder: stillTemplate });
      msg = `Version ${n} published${stillTemplate ? ' (still marked as a template — not used for live analysis)' : ' and is now the approved policy used by AI analysis'}.`;
    });
  } catch (e) {
    if (isRedirect(e)) throw e;
    redirect(`/knowledge-base/${id}?error=${encodeURIComponent(msgOf(e))}`);
  }
  revalidatePath('/knowledge-base');
  revalidatePath(`/knowledge-base/${id}`);
  redirect(`/knowledge-base/${id}?ok=${encodeURIComponent(msg)}`);
}

export async function archiveAction(fd: FormData) {
  const id = String(fd.get('article_id') ?? '');
  if (!isUuid(id)) redirect('/knowledge-base');
  const archive = fd.get('op') !== 'unarchive';
  try {
    const s = await assertPermission('kb.edit');
    await withOrg(s.org.id, async (db) => {
      const a = await db.one<{ status: string; current_version_id: string | null }>('SELECT status, current_version_id FROM knowledge_base_articles WHERE id = $1', [id]);
      if (!a) throw new Error('Article not found');
      const next = archive ? 'archived' : a.current_version_id ? 'published' : 'draft';
      await db.exec('UPDATE knowledge_base_articles SET status = $2, updated_by = $3 WHERE id = $1', [id, next, s.user.id]);
      await auditAction(db, s, archive ? 'kb.archive' : 'kb.unarchive', 'knowledge_base_article', id, { from: a.status, to: next });
    });
  } catch (e) {
    if (isRedirect(e)) throw e;
    redirect(`/knowledge-base/${id}?error=${encodeURIComponent(msgOf(e))}`);
  }
  revalidatePath('/knowledge-base');
  revalidatePath(`/knowledge-base/${id}`);
  redirect(`/knowledge-base/${id}?ok=${encodeURIComponent(archive ? 'Article archived — AI analysis no longer uses it.' : 'Article restored.')}`);
}
