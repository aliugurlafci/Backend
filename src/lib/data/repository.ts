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
  /**
   * Persist a new record into `entity`'s table. When `record.id` is empty the
   * store assigns the next sequential int id (DB IDENTITY / in-memory counter);
   * when it is set (seeding) that explicit id is used. Returns the stored record
   * carrying its assigned id.
   */
  insert(entity: string, record: EntityRecord): Promise<EntityRecord>;
  /**
   * Persist many new records in as few round-trips as possible. Adapters batch
   * the rows into chunked multi-row INSERTs (respecting backend limits, e.g.
   * SQL Server's 2100-parameter / 1000-row caps) instead of one statement per
   * row, so a 20k-row import is a handful of round-trips rather than 20k.
   * Returns the stored records carrying their assigned ids (order not
   * guaranteed to match the input). Throws on the first failing chunk — callers
   * that need per-row error attribution should fall back to `insert` for that
   * chunk.
   */
  bulkInsert(entity: string, records: EntityRecord[]): Promise<EntityRecord[]>;
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
  /**
   * Apply a partial column patch to many records in a single round-trip
   * (`UPDATE … WHERE id IN (…)`). Bumps `version` per row. Returns the count
   * actually changed. Used for bulk operations (e.g. mailbox move/trash).
   */
  updateMany(scope: TenantScope, entity: string, ids: string[], patch: Record<string, unknown>): Promise<number>;
  /** Delete many records by id in a single round-trip. Returns the count deleted. */
  deleteMany(scope: TenantScope, entity: string, ids: string[]): Promise<number>;
  /** Whether a value already exists for a unique field (within the scope). */
  existsByField(scope: TenantScope, entity: string, field: string, value: unknown, exceptId?: string): Promise<boolean>;
  /** Grouped aggregation over scoped records (reports, dashboards). */
  aggregate(scope: TenantScope, entity: string, query: AggregateQuery): Promise<AggregateRow[]>;
  /**
   * Run `fn` atomically: every write performed through this repository inside
   * `fn` commits together, or — if `fn` throws — none of them do (rollback). Used
   * to make multi-step financial/inventory operations all-or-nothing so the GL,
   * sub-ledgers and stock ledger can never be left in a partially-written state.
   * Nested calls join the outer transaction (a single commit/rollback boundary).
   */
  runInTransaction<T>(fn: () => Promise<T>): Promise<T>;
}
