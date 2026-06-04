/**
 * Phase 1 — Foundation
 * Centralized id + correlation generation. Kept behind a module boundary so the
 * strategy (uuid v4 today) can change without touching call sites.
 */
import { randomUUID } from "node:crypto";

export function newId(prefix?: string): string {
  const id = randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

export function newCorrelationId(): string {
  return `cid_${randomUUID()}`;
}
