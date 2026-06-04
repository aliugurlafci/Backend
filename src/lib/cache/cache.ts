/**
 * Phase 11 — cache layer.
 *
 * A small async cache interface (so a Redis adapter can drop in) with TTL,
 * prefix invalidation, and a `wrap` read-through helper. Used by read-heavy,
 * tenant-scoped aggregates such as dashboard stats.
 */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  invalidatePrefix(prefix: string): Promise<void>;
  wrap<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T>;
}

interface Entry {
  value: unknown;
  expires: number;
}

export class InMemoryCache implements Cache {
  private store = new Map<string, Entry>();

  async get<T>(key: string): Promise<T | undefined> {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  async set<T>(key: string, value: T, ttlMs = 30_000): Promise<void> {
    this.store.set(key, { value, expires: Date.now() + ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async invalidatePrefix(prefix: string): Promise<void> {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  async wrap<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;
    const value = await producer();
    await this.set(key, value, ttlMs);
    return value;
  }
}

export const cache: Cache = new InMemoryCache();
