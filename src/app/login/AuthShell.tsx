export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand text-base font-semibold text-white">R</div>
          <div className="leading-tight">
            <p className="text-base font-semibold text-ink">Rosier Support Intelligence</p>
            <p className="text-xs text-ink-muted">Rosier Foods · internal</p>
          </div>
        </div>
        <div className="card p-6">
          <h1 className="text-lg font-semibold text-ink">{title}</h1>
          {subtitle && <p className="mb-5 mt-1 text-sm text-ink-muted">{subtitle}</p>}
          {children}
        </div>
        {footer}
      </div>
    </div>
  );
}
