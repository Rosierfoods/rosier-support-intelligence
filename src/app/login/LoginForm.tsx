'use client';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { loginAction, mfaAction, type FormState } from './actions';

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button disabled={pending} className="h-10 w-full rounded-lg bg-brand text-sm font-medium text-white hover:bg-[#5f3a00] disabled:opacity-60">
      {pending ? 'Please wait…' : label}
    </button>
  );
}

export function LoginForm() {
  const [state, action] = useActionState<FormState, FormData>(loginAction, undefined);
  return (
    <form action={action} className="space-y-4">
      <label className="block">
        <span className="label">Work email</span>
        <input name="email" type="email" autoComplete="username" required className="input h-10" />
      </label>
      <label className="block">
        <span className="label">Password</span>
        <input name="password" type="password" autoComplete="current-password" required className="input h-10" />
      </label>
      {state?.error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{state.error}</p>}
      <Submit label="Sign in" />
    </form>
  );
}

export function MfaForm() {
  const [state, action] = useActionState<FormState, FormData>(mfaAction, undefined);
  return (
    <form action={action} className="space-y-4">
      <label className="block">
        <span className="label">6-digit code from your authenticator app</span>
        <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus
          className="input h-11 text-center text-lg tracking-[0.4em]" />
      </label>
      {state?.error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{state.error}</p>}
      <Submit label="Verify" />
    </form>
  );
}
