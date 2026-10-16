// Simple fixed-window in-memory limiter. For multi-instance deployments put a shared limiter
// (e.g. at the edge / reverse proxy) in front as well; this protects a single instance.
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    return { ok: true, retryAfterMs: 0 };
  }
  b.count++;
  return b.count > limit ? { ok: false, retryAfterMs: b.resetAt - now } : { ok: true, retryAfterMs: 0 };
}
