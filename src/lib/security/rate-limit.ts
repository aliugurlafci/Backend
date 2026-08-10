/**
 * Phase 13 — rate limiting (fixed window).
 *
 * Per-key counters in-memory; a Redis INCR/EXPIRE backs this in production.
 *
 * Keys are per principal AND per path, so the set grows with usage. Expired
 * buckets were never removed, which made this a slow memory leak on a long-lived
 * process — a counter for every route every user has ever touched, kept forever.
 * Expired entries are now swept opportunistically.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Examine at most this many entries per pass, so a large map never stalls a request. */
const SWEEP_BATCH = 512;
/** Only sweep once the map is big enough for the walk to be worth it. */
const SWEEP_THRESHOLD = 1_000;

/**
 * Drop expired buckets from the front of the map.
 *
 * Amortised over requests rather than run on a timer: a timer keeps the process
 * awake and has to be torn down in tests, whereas this costs nothing until the
 * map is actually large.
 *
 * A `Map` iterates in insertion order, so the oldest — and therefore most
 * likely expired — entries come first and the front drains as they are removed.
 * Live entries near the front get re-examined on later passes, which is bounded
 * by the batch size and cheap.
 */
function sweepExpired(now: number): void {
  if (buckets.size < SWEEP_THRESHOLD) return;
  let examined = 0;
  const expired: string[] = [];
  for (const [key, bucket] of buckets) {
    if (++examined > SWEEP_BATCH) break;
    if (bucket.resetAt <= now) expired.push(key);
  }
  for (const key of expired) buckets.delete(key);
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweepExpired(now);
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  const allowed = bucket.count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - bucket.count),
    retryAfter: Math.ceil((bucket.resetAt - now) / 1000),
  };
}

/** Inspect a key's current state WITHOUT counting a hit (for pre-checks like
 *  account lockout, where the increment happens only on a failed attempt). */
export function peekRateLimit(key: string, limit: number): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    return { allowed: true, remaining: limit, retryAfter: 0 };
  }
  return {
    allowed: bucket.count < limit,
    remaining: Math.max(0, limit - bucket.count),
    retryAfter: Math.ceil((bucket.resetAt - now) / 1000),
  };
}

/** Drop a key's counter (e.g. clear failed-login attempts after a success). */
export function clearRateLimit(key: string): void {
  buckets.delete(key);
}

export function resetRateLimits(): void {
  buckets.clear();
}

/** Live bucket count — for the metrics endpoint and for testing the sweep. */
export function rateLimitSize(): number {
  return buckets.size;
}
