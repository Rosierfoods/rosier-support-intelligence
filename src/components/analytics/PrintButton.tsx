'use client';
import { Printer } from 'lucide-react';
import { buttonClass } from '@/components/ui';

export function PrintButton({ label = 'Print / Save as PDF' }: { label?: string }) {
  return (
    <button type="button" onClick={() => window.print()} className={buttonClass('secondary', 'sm', 'print:hidden')}>
      <Printer size={14} aria-hidden /> {label}
    </button>
  );
}
