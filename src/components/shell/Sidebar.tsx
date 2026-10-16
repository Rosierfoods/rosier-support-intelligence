'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { useState } from 'react';
import {
  BookOpen, FileBarChart, GraduationCap, Inbox, LayoutDashboard, Mail, Menu, MessageCircle, Phone, PieChart, Plug,
  ScrollText, Settings, ShieldAlert, Sparkles, UserCog, Users, X, type LucideIcon,
} from 'lucide-react';
import type { NavItem } from './nav';

const ICONS: Record<string, LucideIcon> = {
  LayoutDashboard, Inbox, Phone, MessageCircle, Mail, ShieldAlert, PieChart, Users, GraduationCap, FileBarChart, Plug, Sparkles, BookOpen,
  UserCog, ScrollText, Settings,
};

export function Sidebar({ items, orgName }: { items: (NavItem & { displayLabel: string })[]; orgName: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [prevPath, setPrevPath] = useState(pathname);
  if (prevPath !== pathname) { setPrevPath(pathname); setOpen(false); }
  const groups = Array.from(new Set(items.map((i) => i.group)));

  const nav = (
    <nav className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-semibold text-white">R</div>
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-semibold text-ink">Support Intelligence</p>
          <p className="truncate text-2xs text-ink-muted">{orgName}</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-3 scrollbar-thin">
        {groups.map((g) => (
          <div key={g} className="mb-3">
            <p className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-ink-faint">{g}</p>
            {items.filter((i) => i.group === g).map((i) => {
              const Icon = ICONS[i.icon] ?? LayoutDashboard;
              const active = i.href === '/' ? pathname === '/' : pathname === i.href || pathname.startsWith(i.href + '/');
              return (
                <Link key={i.href} href={i.href}
                  className={clsx('flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition-colors',
                    active ? 'bg-brand-100 font-medium text-brand' : 'text-ink-muted hover:bg-brand-50 hover:text-ink')}>
                  <Icon size={16} className={active ? 'text-brand' : 'text-ink-faint'} />
                  <span className="truncate">{i.displayLabel}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );

  return (
    <>
      <button type="button" aria-label="Open navigation" onClick={() => setOpen(true)}
        className="fixed left-3 top-3 z-40 rounded-lg border border-line bg-white p-1.5 text-ink lg:hidden">
        <Menu size={18} />
      </button>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-line bg-white lg:block">{nav}</aside>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-ink/30" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white shadow-xl">
            <button type="button" aria-label="Close navigation" onClick={() => setOpen(false)} className="absolute right-2 top-3 rounded p-1 text-ink-muted">
              <X size={18} />
            </button>
            {nav}
          </aside>
        </div>
      )}
    </>
  );
}
