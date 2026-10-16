import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Badge } from '@/components/ui';

/**
 * Minimal, safe markdown renderer for KB articles. Supports: ## / ### headings, - / * bullet lists, 1. ordered lists,
 * > blockquotes, **bold**, paragraphs. Output is built from React elements only (no dangerouslySetInnerHTML),
 * so any HTML in the source is rendered as literal text.
 */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<strong key={`${keyBase}-b${k++}`}>{m[1]}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0, key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const k = `h${key++}`;
      blocks.push(h[1].length === 3 ? <h3 key={k} className="mb-1.5 mt-3 text-sm font-semibold">{inline(h[2], k)}</h3> : <h2 key={k}>{inline(h[2], k)}</h2>);
      i++; continue;
    }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      const k = `q${key++}`;
      blocks.push(<blockquote key={k}>{buf.map((b, j) => <p key={j} className="mb-0">{inline(b, `${k}-${j}`)}</p>)}</blockquote>);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      const k = `u${key++}`;
      blocks.push(<ul key={k} className="mb-3">{items.map((t, j) => <li key={j}>{inline(t, `${k}-${j}`)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      const k = `o${key++}`;
      blocks.push(<ol key={k} className="mb-3">{items.map((t, j) => <li key={j}>{inline(t, `${k}-${j}`)}</li>)}</ol>);
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|>|\s*[-*]\s+|\s*\d+[.)]\s+)/.test(lines[i])) buf.push(lines[i++]);
    const k = `p${key++}`;
    blocks.push(<p key={k}>{buf.map((b, j) => <span key={j}>{j > 0 && <br />}{inline(b, `${k}-${j}`)}</span>)}</p>);
  }
  return <div className={clsx('prose-kb text-sm leading-relaxed text-ink', className)}>{blocks}</div>;
}

/** Line diff (LCS). Returns rows for a side-by-side view. */
export type DiffRow = { left: string | null; right: string | null; kind: 'same' | 'removed' | 'added' | 'changed' };
export function lineDiff(a: string, b: string): DiffRow[] {
  const A = a.replace(/\r\n/g, '\n').split('\n').slice(0, 1500), B = b.replace(/\r\n/g, '\n').split('\n').slice(0, 1500);
  const n = A.length, m = B.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const raw: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { raw.push({ left: A[i], right: B[j], kind: 'same' }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) raw.push({ left: A[i++], right: null, kind: 'removed' });
    else raw.push({ left: null, right: B[j++], kind: 'added' });
  }
  while (i < n) raw.push({ left: A[i++], right: null, kind: 'removed' });
  while (j < m) raw.push({ left: null, right: B[j++], kind: 'added' });
  // pair adjacent removed+added into "changed" rows for a tidier side-by-side
  const rows: DiffRow[] = [];
  for (let k = 0; k < raw.length; k++) {
    const r = raw[k], nx = raw[k + 1];
    if (r.kind === 'removed' && nx?.kind === 'added') { rows.push({ left: r.left, right: nx.right, kind: 'changed' }); k++; }
    else rows.push(r);
  }
  return rows;
}

export function DiffView({ before, after, beforeLabel, afterLabel }: { before: string; after: string; beforeLabel: string; afterLabel: string }) {
  const rows = lineDiff(before, after);
  const changes = rows.filter((r) => r.kind !== 'same').length;
  return (
    <div className="overflow-x-auto scrollbar-thin rounded-lg border border-line">
      <table className="w-full table-fixed border-collapse font-mono text-[12px] leading-5">
        <thead className="bg-canvas/60">
          <tr><th className="th w-1/2">{beforeLabel}</th><th className="th w-1/2 border-l border-line">{afterLabel} <span className="font-normal normal-case text-ink-faint">· {changes} changed line{changes === 1 ? '' : 's'}</span></th></tr>
        </thead>
        <tbody>
          {rows.map((r, k) => (
            <tr key={k} className="align-top">
              <td className={clsx('whitespace-pre-wrap break-words px-3 py-0.5', (r.kind === 'removed' || r.kind === 'changed') && 'bg-red-50 text-red-900', r.left === null && 'bg-stone-50')}>
                {r.left !== null ? <>{r.kind !== 'same' && <span aria-hidden className="select-none text-red-700">− </span>}{r.left || ' '}</> : ''}
              </td>
              <td className={clsx('whitespace-pre-wrap break-words border-l border-line px-3 py-0.5', (r.kind === 'added' || r.kind === 'changed') && 'bg-emerald-50 text-emerald-900', r.right === null && 'bg-stone-50')}>
                {r.right !== null ? <>{r.kind !== 'same' && <span aria-hidden className="select-none text-emerald-700">+ </span>}{r.right || ' '}</> : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function KbStatusBadge({ status }: { status: string }) {
  const map: Record<string, ['good' | 'muted' | 'info', string]> = { published: ['good', 'Published'], archived: ['muted', 'Archived'], superseded: ['muted', 'Superseded'], draft: ['info', 'Draft'] };
  const [tone, label] = map[status] ?? ['info', status];
  return <Badge tone={tone}>{label}</Badge>;
}
