/**
 * Phase 7 — Business invariants.
 *
 * Named guards referenced by lifecycle transitions (metadata `guards: [...]`).
 * Each returns `true` when satisfied or an error message when violated.
 */
import type { EntityRecord } from "@/lib/metadata/types";

export type Invariant = (record: EntityRecord) => true | string;

export const INVARIANTS: Record<string, Invariant> = {
  amountPositive: (r) =>
    typeof r.amount === "number" && r.amount > 0
      ? true
      : "amount must be greater than 0 before a deal can be won",
  hasCloseDate: (r) =>
    typeof r.closeDate === "string" && r.closeDate.length > 0
      ? true
      : "a close date is required",
};

/** Run the named guards, returning the list of violation messages (empty = ok). */
export function runGuards(names: string[] | undefined, record: EntityRecord): string[] {
  const failures: string[] = [];
  for (const name of names ?? []) {
    const guard = INVARIANTS[name];
    if (!guard) {
      failures.push(`unknown invariant "${name}"`);
      continue;
    }
    const result = guard(record);
    if (result !== true) failures.push(result);
  }
  return failures;
}
