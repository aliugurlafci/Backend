/**
 * Phase 1 — Foundation
 * Clock abstraction so time can be injected in tests and audit records are
 * produced from a single source of truth.
 */
export interface Clock {
  now(): Date;
  isoNow(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
  isoNow: () => new Date().toISOString(),
};

export function fixedClock(at: Date): Clock {
  return { now: () => at, isoNow: () => at.toISOString() };
}
