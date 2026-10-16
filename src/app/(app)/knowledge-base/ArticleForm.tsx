import { Field } from '@/components/ui';
import { SubmitButton } from '@/components/analytics/SubmitButton';

/** Shared create/edit form (server component; posts to a server action). */
export function ArticleForm({ action, mode, article, body, categories }: {
  action: (fd: FormData) => Promise<void>;
  mode: 'create' | 'edit';
  article?: { id: string; slug: string; title: string; category: string };
  body: string;
  categories: string[];
}) {
  return (
    <form action={action} className="space-y-4">
      {article && <input type="hidden" name="article_id" value={article.id} />}
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Title *"><input name="title" required maxLength={200} defaultValue={article?.title ?? ''} className="input" /></Field>
        <Field label="Category *" hint="e.g. Policy, Procedure, Product, Standard, Templates">
          <input name="category" required maxLength={60} list="kb-categories" defaultValue={article?.category ?? ''} className="input" />
          <datalist id="kb-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        {mode === 'create'
          ? <Field label="Slug *" hint="Permanent id used by AI citations, e.g. gift-hamper-policy"><input name="slug" required pattern="[a-z0-9][a-z0-9\-]{2,80}" className="input font-mono" /></Field>
          : <Field label="Slug"><input value={article?.slug ?? ''} disabled readOnly className="input font-mono" /></Field>}
      </div>
      <Field label="Article text *" hint="Supports ## headings, - bullet lists, 1. numbered lists, **bold** and > notes. HTML is shown as plain text.">
        <textarea name="body" required rows={22} defaultValue={body} className="input h-auto py-2 font-mono text-[13px] leading-relaxed" />
      </Field>
      <Field label="Change note" hint="What changed and who approved it — shown in version history."><input name="change_note" maxLength={500} className="input" placeholder="e.g. Updated refund timeline per Finance (approved by CRM head)" /></Field>
      {mode === 'create' && (
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-1.5"><input type="checkbox" name="publish" /> Publish immediately</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" name="still_template" /> Still a template (not approved for live analysis)</label>
        </div>
      )}
      <div className="flex items-center gap-2">
        <SubmitButton>{mode === 'create' ? 'Create article' : 'Save as new draft'}</SubmitButton>
        {mode === 'edit' && <span className="text-xs text-ink-muted">Saving creates a new draft version; the published version stays in force until you publish the draft.</span>}
      </div>
    </form>
  );
}
