'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import clsx from 'clsx';
import { buttonClass } from '@/components/ui';
import type { ActionResult, FormAction } from './types';

/** A form bound to a server action, showing pending state and the action's success / error message. */
export function ActionForm({ action, children, className, resetOnSuccess, onSuccess, hidden, id }: {
  action: FormAction; children: ReactNode; className?: string; resetOnSuccess?: boolean; onSuccess?: (message?: string) => void;
  hidden?: Record<string, string>; id?: string;
}) {
  const [state, formAction] = useActionState<ActionResult, FormData>(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) {
      if (resetOnSuccess) ref.current?.reset();
      onSuccess?.(state.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return (
    <form ref={ref} id={id} action={formAction} className={className}>
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {children}
      {!(state?.ok && onSuccess) && <FormMessage state={state} />}
    </form>
  );
}

export function FormMessage({ state }: { state: ActionResult }) {
  if (!state) return null;
  return (
    <p role={state.ok ? 'status' : 'alert'} className={clsx('mt-1.5 text-2xs', state.ok ? 'text-emerald-700' : 'text-red-700')}>
      {state.ok ? state.message ?? 'Saved.' : state.error}
    </p>
  );
}

export function SubmitButton({ children, variant = 'secondary', size = 'sm', className, pendingLabel, disabled, title }: {
  children: ReactNode; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; className?: string; pendingLabel?: string;
  disabled?: boolean; title?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending || disabled} title={title} aria-busy={pending} className={buttonClass(variant, size, className)}>
      {pending ? pendingLabel ?? 'Saving…' : children}
    </button>
  );
}
