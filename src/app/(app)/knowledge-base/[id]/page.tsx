import Link from 'next/link';
import { notFound } from 'next/navigation';
import clsx from 'clsx';
import { AlertTriangle, ArrowLeft, Pencil } from 'lucide-react';
import { requirePermission, can } from '@/lib/auth/session';
import { withOrg, isUuid } from '@/lib/db';
import { sp, type SP } from '@/lib/filters';
import { Badge, ButtonLink, Card, CardBody, CardHeader, Notice, PageHeader } from '@/components/ui';
import { SubmitButton } from '@/components/analytics/SubmitButton';
import { fmtDateTime, relTime } from '@/lib/format';
import { Markdown, DiffView, KbStatusBadge } from '../markdown';
import { archiveAction, publishAction } from '../actions';

export const metadata = { title: 'Knowledge Base article' };

export default async function KbArticlePage(props: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const s = await requirePermission('kb.view');
  if (!isUuid(params.id)) notFound();
  const editor = can(s, 'kb.edit');
  const data = await withOrg(s.org.id, async (db) => {
    const a = await db.one(`SELECT a.*, u.name AS updated_by_name FROM knowledge_base_articles a LEFT JOIN users u ON u.id = a.updated_by WHERE a.id = $1`, [params.id]);
    if (!a) return null;
    const versions = await db.query(
      `SELECT v.id, v.version, v.body, v.change_note, v.status, v.published_at, v.created_at, v.is_placeholder, u.name AS author,
              (SELECT count(*)::int FROM ai_analyses an WHERE v.id = ANY(an.kb_version_ids)) AS used_by
         FROM knowledge_base_versions v LEFT JOIN users u ON u.id = v.created_by
        WHERE v.article_id = $1 ORDER BY v.version DESC`, [params.id]);
    return { a, versions };
  });
  if (!data) notFound();
  const { a, versions } = data;
  // Non-editors see published content only.
  if (!editor && a.status !== 'published') notFound();
  const visible = editor ? versions : versions.filter((v: any) => v.status !== 'draft');
  const current = versions.find((v: any) => v.id === a.current_version_id) ?? null;
  const vParam = sp(searchParams, 'v');
  const selected = (vParam && visible.find((v: any) => v.id === vParam)) || current || (editor ? visible[0] : null);
  const prev = selected ? visible.find((v: any) => v.version < selected.version) ?? null : null;
  const compare = sp(searchParams, 'compare') === '1' && !!prev;
  const latestDraft = editor ? versions.find((v: any) => v.status === 'draft' && v.version > (current?.version ?? 0)) : null;
  const ok = sp(searchParams, 'ok'), error = sp(searchParams, 'error');

  return (
    <div className="space-y-5">
      <Link href="/knowledge-base" className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"><ArrowLeft size={14} /> Knowledge Base</Link>
      <PageHeader title={a.title}
        description={<span className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs">{a.slug}</span> · {a.category} · <KbStatusBadge status={a.status} />
          {current?.is_placeholder && <Badge tone="warn"><AlertTriangle size={11} /> Template</Badge>}
          <span className="text-xs">Updated {relTime(a.updated_at)}{a.updated_by_name ? ` by ${a.updated_by_name}` : ''}</span></span>}
        actions={editor ? <>
          <ButtonLink href={`/knowledge-base/${a.id}/edit`} variant="primary"><Pencil size={14} /> Edit (new draft)</ButtonLink>
          <form action={archiveAction}>
            <input type="hidden" name="article_id" value={a.id} />
            <input type="hidden" name="op" value={a.status === 'archived' ? 'unarchive' : 'archive'} />
            <SubmitButton variant="secondary" confirm={a.status === 'archived' ? undefined : 'Archive this article? AI analysis will stop using it.'}>{a.status === 'archived' ? 'Unarchive' : 'Archive'}</SubmitButton>
          </form>
        </> : undefined} />

      {ok && <Notice tone="good">{ok}</Notice>}
      {error && <Notice tone="bad" title="Not saved">{error}</Notice>}
      {a.status === 'archived' && <Notice tone="info" title="Archived">This article is archived and is not used by AI analysis or coaching.</Notice>}
      {current?.is_placeholder && (
        <Notice tone="warn" title="Template / demo policy">
          The published version is marked as a template. For live interactions the AI treats this policy as missing and asks for human review. {editor ? 'Edit it with the approved wording and publish without the “still a template” box.' : ''}
        </Notice>
      )}
      {latestDraft && (
        <Notice tone="info" title={`Draft v${latestDraft.version} is waiting for approval`}>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <Link className="link" href={`/knowledge-base/${a.id}?v=${latestDraft.id}${current ? '&compare=1' : ''}`}>Review changes</Link>
            <form action={publishAction} className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="article_id" value={a.id} />
              <input type="hidden" name="version_id" value={latestDraft.id} />
              <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" name="still_template" /> Still a template (don’t use for live analysis)</label>
              <SubmitButton size="sm" confirm={`Publish v${latestDraft.version}? It becomes the approved policy used by AI analysis from now on.`}>Publish v{latestDraft.version}</SubmitButton>
            </form>
          </div>
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <CardHeader
            title={selected ? <span className="flex items-center gap-2">Version {selected.version} <KbStatusBadge status={selected.status} />{selected.is_placeholder && <Badge tone="warn">Template</Badge>}</span> : 'No content'}
            subtitle={selected ? <>{selected.status === 'published' ? `Published ${fmtDateTime(selected.published_at)}` : `Created ${fmtDateTime(selected.created_at)}`}{selected.author ? ` by ${selected.author}` : ''}{selected.change_note ? ` · “${selected.change_note}”` : ''}</> : undefined}
            actions={prev ? (
              <Link href={`/knowledge-base/${a.id}?v=${selected!.id}${compare ? '' : '&compare=1'}`} className={clsx('text-xs', compare ? 'link font-medium' : 'link')}>
                {compare ? 'Show rendered' : `Compare with v${prev.version}`}
              </Link>
            ) : undefined} />
          <CardBody>
            {!selected ? <p className="text-sm text-ink-muted">This article has no published version yet.</p>
              : compare && prev ? <DiffView before={prev.body} after={selected.body} beforeLabel={`v${prev.version} (${prev.status})`} afterLabel={`v${selected.version} (${selected.status})`} />
                : <Markdown source={selected.body} />}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Version history" subtitle="AI analyses record the exact version they used." />
          <ul className="divide-y divide-line">
            {visible.map((v: any) => (
              <li key={v.id}>
                <Link href={`/knowledge-base/${a.id}?v=${v.id}`} className={clsx('block px-4 py-2.5 hover:bg-brand-50/50', selected?.id === v.id && 'bg-brand-50')}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">v{v.version}</span>
                    <span className="flex items-center gap-1">
                      {v.is_placeholder && <Badge tone="warn">Template</Badge>}
                      <Badge tone={v.status === 'published' ? 'good' : v.status === 'draft' ? 'info' : 'muted'}>{v.status === 'published' ? 'Current' : v.status === 'draft' ? 'Draft' : 'Superseded'}</Badge>
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-2xs text-ink-muted">{v.change_note || 'No change note'}</p>
                  <p className="text-2xs text-ink-faint">{fmtDateTime(v.published_at ?? v.created_at)}{v.author ? ` · ${v.author}` : ''}{v.used_by ? ` · used by ${v.used_by} analyses` : ''}</p>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
