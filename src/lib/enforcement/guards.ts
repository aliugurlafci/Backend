/**
 * Phase 3 — Runtime guards.
 *
 * Small assertion helpers that translate enforcement failures into structured
 * errors. They take structural types (not imports of higher layers) so the
 * enforcement layer stays at the bottom of the dependency graph; the context,
 * permission and metadata layers feed their results in.
 */
import {
  ForbiddenError,
  NotFoundError,
  TenantIsolationError,
  ValidationError,
} from "./errors";

export function assertFound<T>(
  value: T | null | undefined,
  entity: string,
  id?: string,
): asserts value is T {
  if (value === null || value === undefined) throw new NotFoundError(entity, id);
}

interface OutcomeLike {
  success: boolean;
  issues?: { field: string; message: string }[];
}

export function assertValid(outcome: OutcomeLike): void {
  if (!outcome.success) {
    throw new ValidationError(
      (outcome.issues ?? []).map((i) => ({ field: i.field, message: i.message })),
    );
  }
}

interface Scoped {
  tenantId: string;
  orgId: string;
}

/**
 * Tenant isolation guarantee: a record from a different tenant/org is treated
 * as if it does not exist (404), never leaking cross-tenant existence.
 */
export function assertSameTenant(ctx: Scoped, record: Scoped): void {
  if (ctx.tenantId !== record.tenantId || ctx.orgId !== record.orgId) {
    throw new TenantIsolationError();
  }
}

interface DecisionLike {
  allowed: boolean;
  reason: string;
}

export function assertAllowed(decision: DecisionLike): void {
  if (!decision.allowed) throw new ForbiddenError(decision.reason);
}
