'use client';
import { useEffect } from 'react';

/** Scrolls the highlighted evidence element into view after navigation (hash scrolling is unreliable with client routing). */
export function ScrollToEvidence({ targetId = 'evidence', dep }: { targetId?: string; dep?: string | null }) {
  useEffect(() => {
    if (!dep) return;
    const t = setTimeout(() => {
      const el = document.getElementById(targetId);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        (el as HTMLElement).focus?.({ preventScroll: true });
      }
    }, 150);
    return () => clearTimeout(t);
  }, [targetId, dep]);
  return null;
}
