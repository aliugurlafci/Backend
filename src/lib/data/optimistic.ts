/**
 * Optimistic-concurrency retry helper.
 *
 * Read-compute-write flows that re-derive a stored value (e.g. invoice
 * amountPaid/balance, POS session totals) must not lose updates when two writers
 * race. They version-guard the final write (`patchComputed(..., expectedVersion)`);
 * on a `ConflictError` the whole read-compute-write is replayed against the fresh
 * version. The computation is idempotent (re-derives from the source rows), so a
 * replay converges.
 */
import { ConflictError } from "@/lib/enforcement/errors";

export async function retryOnConflict<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ConflictError) {
        lastError = e;
        continue; // re-read + recompute against the new version
      }
      throw e;
    }
  }
  throw lastError;
}
