/**
 * Phase 4 — Isolation guarantees.
 *
 * Helpers that derive the tenant scope from a context and stamp it onto new
 * records, so the data layer can never accidentally write across tenants.
 */
import type { RequestContext, TenantScope } from "./types";

export function scopeOf(ctx: RequestContext): TenantScope {
  return { tenantId: ctx.tenantId, orgId: ctx.orgId };
}

/** True when a scoped record belongs to the context's tenant + org. */
export function inScope(ctx: RequestContext, record: TenantScope): boolean {
  return record.tenantId === ctx.tenantId && record.orgId === ctx.orgId;
}
