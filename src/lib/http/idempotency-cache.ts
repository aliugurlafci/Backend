/**
 * Request-level idempotency for mutating endpoints.
 *
 * Collapses a double-submit (same `Idempotency-Key`) onto the first request: a
 * duplicate that arrives while the first is in flight — or within ~60s after it
 * settles — receives the first result instead of performing the mutation twice.
 * A failed attempt is dropped immediately so a genuine retry can proceed.
 *
 * In-process only (like the rate limiter / webhook registry); a Redis SETNX with
 * a cached response backs this across instances in production.
 */
const inflight = new Map<string, Promise<unknown>>();

export async function withIdempotency<T>(key: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fn();
  inflight.set(key, p);
  p.then(
    () => {
      const timer = setTimeout(() => inflight.delete(key), 60_000);
      timer.unref?.();
    },
    () => inflight.delete(key), // failed → allow a genuine retry
  );
  return p;
}
