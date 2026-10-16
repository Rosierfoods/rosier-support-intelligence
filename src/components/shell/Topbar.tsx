'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Bell, ChevronDown, LogOut, Search, ShieldAlert, UserRound } from 'lucide-react';
import clsx from 'clsx';

interface Notif { id: string; title: string; body: string | null; link: string | null; severity: string | null; created_at: string; read_at: string | null }

function useClickAway(cb: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) cb(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [cb]);
  return ref;
}

export function Topbar({ user, notifications, unread, criticalOpen, canSearch, canSeeAlerts, markAllRead, logoutAction }: {
  user: { name: string; roleLabel: string; email: string };
  notifications: Notif[]; unread: number; criticalOpen: number; canSearch: boolean; canSeeAlerts: boolean;
  markAllRead: () => Promise<void>; logoutAction: () => Promise<void>;
}) {
  const [notifOpen, setNotifOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const nRef = useClickAway(() => setNotifOpen(false));
  const mRef = useClickAway(() => setMenuOpen(false));

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-white/90 px-4 pl-14 backdrop-blur lg:pl-6">
      {canSearch ? (
        <form action="/search" className="relative max-w-xl flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input name="q" placeholder='Search transcripts, messages, IDs, agents… e.g. "ghee jar leaking"'
            className="input h-9 pl-9" aria-label="Global search" />
        </form>
      ) : <div className="flex-1" />}
      <div className="ml-auto flex items-center gap-1.5">
        {canSeeAlerts && (
          <Link href="/quality?severity=critical&status=open"
            className={clsx('hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium sm:inline-flex',
              criticalOpen > 0 ? 'bg-red-50 text-red-800 ring-1 ring-inset ring-red-200 hover:bg-red-100' : 'text-ink-muted hover:bg-brand-50')}
            title="Open critical quality alerts">
            <ShieldAlert size={14} /> {criticalOpen} critical
          </Link>
        )}
        <div className="relative" ref={nRef}>
          <button type="button" onClick={() => setNotifOpen((v) => !v)} className="relative rounded-lg p-2 text-ink-muted hover:bg-brand-50" aria-label="Notifications">
            <Bell size={18} />
            {unread > 0 && <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">{unread > 9 ? '9+' : unread}</span>}
          </button>
          {notifOpen && (
            <div className="absolute right-0 mt-2 w-[22rem] max-w-[90vw] overflow-hidden rounded-xl border border-line bg-white shadow-lg">
              <div className="flex items-center justify-between border-b border-line px-3 py-2">
                <p className="text-sm font-semibold">Notifications</p>
                {unread > 0 && (
                  <form action={markAllRead}><button className="text-xs text-brand hover:underline">Mark all read</button></form>
                )}
              </div>
              <div className="max-h-96 overflow-y-auto scrollbar-thin">
                {notifications.length === 0 && <p className="px-3 py-6 text-center text-sm text-ink-muted">You’re all caught up.</p>}
                {notifications.map((n) => (
                  <Link key={n.id} href={n.link ?? '#'} onClick={() => setNotifOpen(false)}
                    className={clsx('block border-b border-line px-3 py-2.5 last:border-0 hover:bg-brand-50', !n.read_at && 'bg-brand-50/50')}>
                    <p className={clsx('text-[13px] font-medium', n.severity === 'critical' ? 'text-red-800' : 'text-ink')}>{n.title}</p>
                    {n.body && <p className="mt-0.5 text-xs text-ink-muted">{n.body}</p>}
                    <p className="mt-0.5 text-2xs text-ink-faint">{new Date(n.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}</p>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="relative" ref={mRef}>
          <button type="button" onClick={() => setMenuOpen((v) => !v)} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-brand-50">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-sand text-xs font-semibold text-brand">
              {user.name.split(' ').map((p) => p[0]).slice(0, 2).join('')}
            </span>
            <span className="hidden text-left leading-tight md:block">
              <span className="block text-xs font-medium text-ink">{user.name}</span>
              <span className="block text-2xs text-ink-muted">{user.roleLabel}</span>
            </span>
            <ChevronDown size={14} className="text-ink-faint" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 mt-2 w-56 overflow-hidden rounded-xl border border-line bg-white py-1 shadow-lg">
              <p className="truncate px-3 py-2 text-xs text-ink-muted">{user.email}</p>
              <Link href="/profile" className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-brand-50" onClick={() => setMenuOpen(false)}>
                <UserRound size={15} /> Profile & security
              </Link>
              <form action={logoutAction}>
                <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-brand-50"><LogOut size={15} /> Sign out</button>
              </form>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
