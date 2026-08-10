/**
 * Phase 5 — Repository abstraction.
 *
 * The persistence contract. Adapters implement raw, tenant-scoped storage; all
 * enforcement (permissions, validation, isolation) lives above this in the
 * query engine, so adapters stay dumb and swappable (in-memory <-> PostgreSQL).
 */
import type { EntityRecord } from "@/lib/metadata/types";
import type { TenantScope } from "@/lib/context/types";
import type { AggregateQuery, AggregateRow, Cursor, Filter, Page, RepoQuery } from "./query";

export interface Repository {
  list(scope: TenantScope, entity: string, query: RepoQuery): Promise<Page>;
  /**
   * One page, resuming strictly after `cursor` in the query's own sort order.
   *
   * The alternative to `list`'s offset, and not merely faster: offset paging
   * asks for "the rows after the first N", which a concurrent insert or delete
   * silently redefines between pages, so a walk over a live table skips records
   * and repeats others. A cursor names a row, so it stays put.
   *
   * Returns the last row alongside the page so the caller can mint the next
   * cursor without knowing which fields the sort used.
   */
  listAfter(
    scope: TenantScope,
    entity: string,
    query: RepoQuery,
    cursor: Cursor | null,
  ): Promise<{ items: EntityRecord[]; last: EntityRecord | null }>;
  get(scope: TenantScope, entity: string, id: string): Promise<EntityRecord | null>;
  /**
   * Read one scoped row under an exclusive row lock, so a concurrent transaction
   * blocks here rather than acting on a stale value. Returns null when no row
   * matches — the lock still covers that absence, so two transactions cannot
   * both conclude "not there yet" and both insert.
   *
   * MUST be called inside `runInTransaction`; adapters throw otherwise, because
   * outside a transaction the lock is released immediately and the guarantee is
   * silently worthless.
   *
   * This is what makes read-then-write safe. A plain `get` plus optimistic retry
   * is NOT equivalent: under MySQL's REPEATABLE READ the retry re-reads the same
   * snapshot inside the same transaction and spins until it exhausts its
   * attempts, surfacing a version conflict instead of the real condition.
   */
  getForUpdate(scope: TenantScope, entity: string, filters: Filter[]): Promise<EntityRecord | null>;
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
