/**
 * Errors raised by provider adapters and pipeline steps.
 * `retryable` drives job backoff (pipeline/jobs.ts failJob); `userMessage` is safe to show in the UI
 * (never contains secrets, audio, transcript or message text).
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly code?: string;
  readonly requestId?: string;
  constructor(provider: string, message: string, opts: { status?: number; retryable?: boolean; retryAfterMs?: number; code?: string; requestId?: string } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
    this.code = opts.code;
    this.requestId = opts.requestId;
  }
}

/** A pipeline failure with a human-readable message for interactions.processing_error. */
export class PipelineError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(message: string, opts: { retryable?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'PipelineError';
    this.retryable = opts.retryable ?? true;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError || err instanceof PipelineError) return err.retryable;
  return true; // unknown errors (network, DB) → retry with backoff
}

export function retryAfterOf(err: unknown): number | undefined {
  if (err instanceof ProviderError || err instanceof PipelineError) return err.retryAfterMs;
  return undefined;
}

/** Parse an HTTP Retry-After header (seconds or HTTP date) into ms. */
export function parseRetryAfter(h: string | null | undefined): number | undefined {
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
