/**
 * Phase 8 — idempotency keys.
 *
 * Ensures an effect (event delivery, webhook, workflow step) runs at most once
 * per key. In production this maps to a Redis SETNX / unique table row.
 */
export class IdempotencyStore {
  private seen = new Map<string, string>();

  has(key: string): boolean {
    return this.seen.has(key);
  }

  /** Record the key; returns false if it was already present. */
  remember(key: string, at: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.set(key, at);
    return true;
  }

  /** Run `fn` only if the key has not been seen before. */
  async runOnce<T>(key: string, at: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (!this.remember(key, at)) return undefined;
    return fn();
  }
}

export const idempotencyStore = new IdempotencyStore();
