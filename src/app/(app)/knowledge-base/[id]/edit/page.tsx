import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requirePermission } from '@/lib/auth/session';
import { withOrg, isUuid } from '@/lib/db';
import { sp, type SP } from '@/lib/filters';
import { Card, CardBody, Notice, PageHeader } from '@/components/ui';
import { ArticleForm } from '../../ArticleForm';
import { saveDraftAction } from '../../actions';

export const metadata = { title: 'Edit KB article' };

export default async function EditKbArticlePage(props: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const s = await requirePermission('kb.edit');
  if (!isUuid(params.id)) notFound();
  const data = await withOrg(s.org.id, async (db) => {
    const a = await db.one('SELECT id, slug, title, category, current_version_id FROM knowledge_base_articles WHERE id = $1', [params.id]);
    if (!a) return null;
    // start from the newest version (a pending draft if any, else the published one)
    const latest = await db.one<{ version: number; body: string; status: string; is_placeholder: boolean }>(
      'SELECT version, body, status, is_placeholder FROM knowledge_base_versions WHERE article_id = $1 ORDER BY version DESC LIMIT 1', [params.id]);
    const cats = await db.query<{ category: string }>('SELECT DISTINCT category FROM knowledge_base_articles ORDER BY 1');
    return { a, latest, cats: cats.map((c) => c.category) };
  });
  if (!data) notFound();
  const error = sp(searchParams, 'error');
  return (
    <div className="space-y-5">
      <Link href={`/knowledge-base/${data.a.id}`} className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"><ArrowLeft size={14} /> Back to article</Link>
      <PageHeader title={`Edit: ${data.a.title}`} description={data.latest ? `Starting from v${data.latest.version} (${data.latest.status}).` : 'No previous version.'} />
      {error && <Notice tone="bad" title="Not saved">{error}</Notice>}
      {data.latest?.is_placeholder && (
        <Notice tone="warn" title="This text is a template">Replace the template wording (including the template warning at the top) with Rosier Foods’ approved policy before publishing.</Notice>
      )}
      <Card><CardBody><ArticleForm action={saveDraftAction} mode="edit" article={data.a} body={data.latest?.body ?? ''} categories={data.cats} /></CardBody></Card>
    </div>
  );
}
