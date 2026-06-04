/**
 * Phase 7 — Audit logging.
 *
 * An append-only trail of every state-changing operation, scoped by tenant.
 * Records who did what, when, and (for transitions) the before/after state.
 */
import { newId } from "@/lib/core/ids";
import type { RequestContext, TenantScope } from "@/lib/context/types";

export type AuditAction = "create" | "update" | "delete" | "transition";

export interface AuditEntry {
  id: string;
  at: string;
  tenantId: string;
  orgId: string;
  actorId: string;
  correlationId: string;
  entity: string;
  recordId: string;
  action: AuditAction;
  summary: string;
  from?: string;
  to?: string;
}

export class AuditLog {
  private entries: AuditEntry[] = [];

  append(
    ctx: RequestContext,
    input: Omit<AuditEntry, "id" | "at" | "tenantId" | "orgId" | "actorId" | "correlationId">,
  ): AuditEntry {
    const entry: AuditEntry = {
      id: newId("audit"),
      at: ctx.at,
      tenantId: ctx.tenantId,
      orgId: ctx.orgId,
      actorId: ctx.userId,
      correlationId: ctx.correlationId,
      ...input,
    };
    this.entries.push(entry);
    return entry;
  }

  query(scope: TenantScope, filter?: { entity?: string; recordId?: string }): AuditEntry[] {
    return this.entries
      .filter((e) => e.tenantId === scope.tenantId && e.orgId === scope.orgId)
      .filter((e) => (filter?.entity ? e.entity === filter.entity : true))
      .filter((e) => (filter?.recordId ? e.recordId === filter.recordId : true))
      .sort((a, b) => (a.at < b.at ? 1 : -1));
  }
}

export const auditLog = new AuditLog();
