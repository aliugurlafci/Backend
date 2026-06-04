/**
 * Phase 5 — Repository abstraction.
 *
 * The persistence contract. Adapters implement raw, tenant-scoped storage; all
 * enforcement (permissions, validation, isolation) lives above this in the
 * query engine, so adapters stay dumb and swappable (in-memory <-> PostgreSQL).
 */
import type { EntityRecord } from "@/lib/metadata/types";
import type { TenantScope } from "@/lib/context/types";
import type { AggregateQuery, AggregateRow, Page, RepoQuery } from "./query";

export interface Repository {
  list(scope: TenantScope, entity: string, query: RepoQuery): Promise<Page>;
  get(scope: TenantScope, entity: string, id: string): Promise<EntityRecord | null>;
  insert(record: EntityRecord): Promise<EntityRecord>;
  /**
   * Replace a record. `expectedVersion`, when provided, must match the stored
   * version or a concurrency conflict is raised (optimistic locking).
   */
  update(
    scope: TenantScope,
    entity: string,
    next: EntityRecord,
    expectedVersion?: number,
  ): Promise<EntityRecord>;
  delete(scope: TenantScope, entity: string, id: string, expectedVersion?: number): Promise<void>;
  /** Whether a value already exists for a unique field (within the scope). */
  existsByField(scope: TenantScope, entity: string, field: string, value: unknown, exceptId?: string): Promise<boolean>;
  /** Grouped aggregation over scoped records (reports, dashboards). */
  aggregate(scope: TenantScope, entity: string, query: AggregateQuery): Promise<AggregateRow[]>;
}
