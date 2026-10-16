import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Human-readable interaction reference: "RSI-" + 6 base36 characters (≈2.2 billion combinations). */
export function generateRef(): string {
  const bytes = randomBytes(6);
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[bytes[i] % 36];
  return `RSI-${s}`;
}

export const REF_RE = /^RSI-[0-9A-Z]{6}$/;
