/**
 * Phase 8 — retry with exponential backoff.
 */
export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  onRetry?: (attempt: number, error: unknown) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseMs ?? 50;
  const max = opts.maxMs ?? 2_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        opts.onRetry?.(attempt, error);
        await sleep(Math.min(max, base * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastError;
}
