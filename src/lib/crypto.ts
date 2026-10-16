import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * AES-256-GCM envelope for integration credentials and MFA secrets.
 * Key: SECRETS_ENCRYPTION_KEY (32 bytes, base64). Format: v1.<iv>.<tag>.<ciphertext> (base64url parts).
 */
function key(): Buffer {
  const raw = process.env.SECRETS_ENCRYPTION_KEY;
  if (!raw) throw new Error('SECRETS_ENCRYPTION_KEY is not set (32 random bytes, base64). See .env.example.');
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('SECRETS_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  return k;
}

export function encryptString(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptString(blob: string): string {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unrecognised secret format');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

export function encryptJson(obj: Record<string, unknown>): string {
  return encryptString(JSON.stringify(obj));
}

export function decryptJson<T = Record<string, string>>(blob: string | null | undefined): T {
  if (!blob) return {} as T;
  return JSON.parse(decryptString(blob)) as T;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256Hex(secret: string | Buffer, body: string | Buffer): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Mask a secret for display: keeps the last 4 characters. */
export function maskSecret(value: string | undefined | null): string {
  if (!value) return '';
  if (value.length <= 6) return '••••••';
  return '••••••••' + value.slice(-4);
}

export function normalisePhone(p: string | null | undefined): string | null {
  if (!p) return null;
  const digits = p.replace(/\D/g, '');
  if (digits.length < 8) return null;
  return digits.length === 10 ? '91' + digits : digits.replace(/^0+/, '');
}

export function maskPhone(p: string | null | undefined): string {
  if (!p) return '—';
  const d = p.replace(/\D/g, '');
  if (d.length < 4) return '••••';
  return '••••••' + d.slice(-4);
}

export function maskEmail(e: string | null | undefined): string {
  if (!e) return '—';
  const [u, dom] = e.split('@');
  if (!dom) return '••••';
  return (u.slice(0, 1) || '') + '•••@' + dom;
}
