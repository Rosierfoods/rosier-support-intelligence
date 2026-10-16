'use client';
import { useFormStatus } from 'react-dom';
import { buttonClass } from '@/components/ui';

export function SubmitButton({ children, variant = 'primary', size = 'md', className, confirm, name, value }: {
  children: React.ReactNode; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; className?: string;
  confirm?: string; name?: string; value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" name={name} value={value} disabled={pending} className={buttonClass(variant, size, className)}
      onClick={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}>
      {pending ? 'Working…' : children}
    </button>
  );
}
