'use client';
/**
 * Small wrapper around a server action that returns { ok, error?, message?, secret? }.
 * Shows the result inline (role=status / role=alert). `secret` is displayed once (e.g. a temporary password)
 * and never stored client-side beyond this component's state.
 */
import { useActionState } from 'react';
import { useEffect, useRef, type ReactNode } from 'react';
import clsx from 'clsx';

export type ActionResult = { ok: boolean; error?: string; message?: string; secret?: string; secretLabel?: string } | undefined;

export function ActionForm({ action, children, className, resetOnSuccess = false, inline = false }: {
  action: (prev: ActionResult, fd: FormData) => Promise<ActionResult>; children: ReactNode; className?: string; resetOnSuccess?: boolean; inline?: boolean;
}) {
  const [state, formAction] = useActionState<ActionResult, FormData>(action, undefined);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => { if (state?.ok && resetOnSuccess) ref.current?.reset(); }, [state, resetOnSuccess]);
  return (
    <form ref={ref} action={formAction} className={className}>
      {children}
      {state?.error && <p role="alert" className={clsx('rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800', inline ? 'mt-1' : 'mt-3')}>{state.error}</p>}
      {state?.ok && state.message && <p role="status" className={clsx('rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900', inline ? 'mt-1' : 'mt-3')}>{state.message}</p>}
      {state?.ok && state.secret && (
        <div role="status" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <p className="font-medium">{state.secretLabel ?? 'Temporary password'} — shown once. Share it securely; the user must change it after signing in.</p>
          <code className="mt-1 block select-all break-all rounded bg-white px-2 py-1 font-mono text-sm text-ink ring-1 ring-amber-200">{state.secret}</code>
        </div>
      )}
    </form>
  );
}
