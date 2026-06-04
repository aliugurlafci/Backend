/**
 * Phase 6 — Permission decision cache.
 *
 * Permission evaluation is pure with respect to (roles, action, ownership
 * relation, field), so decisions are memoized with a short TTL. A bounded map
 * with FIFO eviction keeps memory predictable.
 */
export class DecisionCache<V> {
  private store = new Map<string, { value: V; expires: number }>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly maxSize = 5_000,
  ) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }
}
