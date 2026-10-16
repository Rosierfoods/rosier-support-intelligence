import Link from 'next/link';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Info } from 'lucide-react';

// ───────────────────────── Layout ─────────────────────────
export function PageHeader({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-ink-muted">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ className, children, id }: { className?: string; children: ReactNode; id?: string }) {
  return <section id={id} className={clsx('card', className)}>{children}</section>;
}

export function CardHeader({ title, subtitle, actions, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex items-start justify-between gap-3 border-b border-line px-4 py-3', className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx('p-4', className)}>{children}</div>;
}

export function Grid({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx('grid gap-4', className)}>{children}</div>;
}

// ───────────────────────── Buttons ─────────────────────────
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
const btnBase = 'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 disabled:cursor-not-allowed disabled:opacity-50';
const btnVariants: Record<BtnVariant, string> = {
  primary: 'bg-brand text-white hover:bg-[#5f3a00]',
  secondary: 'border border-line bg-white text-ink hover:bg-brand-50',
  ghost: 'text-ink-muted hover:bg-brand-50 hover:text-ink',
  danger: 'bg-red-700 text-white hover:bg-red-800',
};
const btnSizes = { sm: 'h-8 px-2.5 text-xs', md: 'h-9 px-3.5' } as const;

export function buttonClass(variant: BtnVariant = 'secondary', size: keyof typeof btnSizes = 'md', className?: string) {
  return clsx(btnBase, btnVariants[variant], btnSizes[size], className);
}

export function Button({ variant = 'secondary', size = 'md', className, children, ...rest }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: keyof typeof btnSizes }) {
  return <button className={buttonClass(variant, size, className)} {...rest}>{children}</button>;
}

export function ButtonLink({ href, variant = 'secondary', size = 'md', className, children, prefetch }:
  { href: string; variant?: BtnVariant; size?: keyof typeof btnSizes; className?: string; children: ReactNode; prefetch?: boolean }) {
  return <Link href={href} prefetch={prefetch} className={buttonClass(variant, size, className)}>{children}</Link>;
}

// ───────────────────────── Badges ─────────────────────────
export type Tone = 'neutral' | 'brand' | 'good' | 'warn' | 'bad' | 'info' | 'muted';
const tones: Record<Tone, string> = {
  neutral: 'bg-stone-100 text-stone-700 ring-stone-200',
  brand: 'bg-brand-100 text-brand ring-brand-500/20',
  good: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  warn: 'bg-amber-50 text-amber-800 ring-amber-200',
  bad: 'bg-red-50 text-red-800 ring-red-200',
  info: 'bg-sky-50 text-sky-800 ring-sky-200',
  muted: 'bg-white text-ink-muted ring-line',
};
export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={clsx('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-2xs font-medium ring-1 ring-inset', tones[tone], className)}>
      {children}
    </span>
  );
}

export function DemoBadge({ className }: { className?: string }) {
  return <Badge tone="warn" className={clsx('font-semibold tracking-wide', className)} title="Synthetic sample data — not real customer data">DEMO DATA</Badge>;
}

// ───────────────────────── Tables ─────────────────────────
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('overflow-x-auto scrollbar-thin', className)}>
      <table className="min-w-full divide-y divide-line">{children}</table>
    </div>
  );
}
export function THead({ children }: { children: ReactNode }) {
  return <thead className="bg-canvas/60">{children}</thead>;
}
export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-line bg-white">{children}</tbody>;
}

// ───────────────────────── Misc ─────────────────────────
export function EmptyState({ title, description, action, icon }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && <div className="mb-3 text-ink-faint">{icon}</div>}
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="mt-1 max-w-md text-sm text-ink-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function KpiCard({ label, value, sub, tone, formula, href, demo }: {
  label: string; value: ReactNode; sub?: ReactNode; tone?: 'bad' | 'warn' | 'good'; formula?: string; href?: string; demo?: boolean;
}) {
  const inner = (
    <div className={clsx('card h-full px-4 py-3', href && 'transition-colors hover:border-brand-500/40')}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-ink-muted">{label}</p>
        {formula && (
          <span title={formula} className="cursor-help text-ink-faint" aria-label={`How this is calculated: ${formula}`}>
            <Info size={13} />
          </span>
        )}
      </div>
      <p className={clsx('mt-1 text-2xl font-semibold tabular-nums tracking-tight',
        tone === 'bad' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : 'text-ink')}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-muted">{sub}</p>}
      {demo && <span className="sr-only">Demo data</span>}
    </div>
  );
  return href ? <Link href={href} className="block h-full">{inner}</Link> : inner;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-2xs text-ink-faint">{hint}</span>}
    </label>
  );
}

export function Notice({ tone = 'info', title, children, className }: { tone?: 'info' | 'warn' | 'bad' | 'good'; title?: string; children?: ReactNode; className?: string }) {
  const map = { info: 'border-sky-200 bg-sky-50 text-sky-900', warn: 'border-amber-200 bg-amber-50 text-amber-900', bad: 'border-red-200 bg-red-50 text-red-900', good: 'border-emerald-200 bg-emerald-50 text-emerald-900' };
  return (
    <div className={clsx('rounded-lg border px-3 py-2 text-sm', map[tone], className)}>
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={clsx(title && 'mt-0.5', 'text-[13px] leading-relaxed')}>{children}</div>}
    </div>
  );
}

export function KeyValue({ items, className }: { items: [string, ReactNode][]; className?: string }) {
  return (
    <dl className={clsx('grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2', className)}>
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{k}</dt>
          <dd className="mt-0.5 break-words text-ink">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-muted">{children}</h3>;
}
