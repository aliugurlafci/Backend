/**
 * Phase 7 — Audit logging.
 *
 * An append-only trail of every state-changing operation, scoped by tenant:
 * who did what, when, and (for transitions) the before/after state.
 *
 * Backed by the `auditEntry` table. It used to be an in-process array — which
 * grew without bound and was wiped by every restart, so the record of who voided
 * an invoice survived exactly as long as the process did.
 *
 * Writes go through the query engine under a system context, so an entry lands
 * inside whatever transaction the change it describes is running in: roll the
 * operation back and the entry goes with it.
 */
import { systemContext } from "@/lib/context/resolver";
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import type { EntityRecord } from "@/lib/metadata/types";
import { logger } from "@/lib/observability/logger";

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
  /** Display name of the actor (attached by the activity API from `actorId`). */
  actorName?: string;
}

export type AuditInput = Omit<
  AuditEntry,
  "id" | "at" | "tenantId" | "orgId" | "actorId" | "correlationId" | "actorName"
>;

/** Storage shape → the shape callers have always consumed. */
function toEntry(row: EntityRecord): AuditEntry {
  return {
    id: String(row.id),
    at: String(row.at ?? row.createdAt),
    tenantId: String(row.tenantId),
    orgId: String(row.orgId),
    actorId: String(row.actorId ?? ""),
    correlationId: String(row.correlationId ?? ""),
    entity: String(row.entityName ?? ""),
    recordId: String(row.recordId ?? ""),
    action: String(row.action) as AuditAction,
    summary: String(row.summary ?? ""),
    from: row.fromState ? String(row.fromState) : undefined,
    to: row.toState ? String(row.toState) : undefined,
  };
}

export class AuditLog {
  /**
   * Record a change.
   *
   * Best-effort by design: a failure here is logged but never propagated. The
   * audit row is a description of an operation, and losing the description must
   * not roll back the operation itself — a write that succeeded should not be
   * undone because its trail entry could not be stored.
   */
  async append(ctx: RequestContext, input: AuditInput): Promise<void> {
    try {
      const qe = await getQueryEngine();
      const sys = systemContext(ctx.tenantId, ctx.orgId, {
        userId: ctx.userId,
        displayName: ctx.displayName,
        email: ctx.email,
      });
      await qe.create(sys, "auditEntry", {
        at: ctx.at,
        actorId: ctx.userId,
        correlationId: ctx.correlationId,
        entityName: input.entity,
        recordId: input.recordId,
        action: input.action,
        summary: input.summary,
        fromState: input.from ?? null,
        toState: input.to ?? null,
      });
    } catch (e) {
      logger.warn("audit entry not recorded", {
        entity: input.entity,
        action: input.action,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Most recent entries first, optionally narrowed to one record. */
  async query(
    ctx: RequestContext,
    filter: { entity?: string; recordId?: string; limit?: number } = {},
  ): Promise<AuditEntry[]> {
    const qe = await getQueryEngine();
    const sys = systemContext(ctx.tenantId, ctx.orgId, {
      userId: ctx.userId,
      displayName: ctx.displayName,
      email: ctx.email,
    });
    const filters = [];
    if (filter.entity) filters.push({ field: "entityName", op: "eq" as const, value: filter.entity });
    if (filter.recordId) filters.push({ field: "recordId", op: "eq" as const, value: filter.recordId });
    // Deliberately a window, not the whole trail: this table only grows.
    const limit = Math.min(Math.max(1, filter.limit ?? 50), 200);
    const page = await qe.list(sys, "auditEntry", {
      filters,
      sort: [{ field: "at", dir: "desc" }],
      pageSize: limit,
    });
    return page.items.map(toEntry);
  }
}

export const auditLog = new AuditLog();
