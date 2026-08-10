/**
 * Phase 5 — In-memory repository adapter (default backend).
 *
 * Stores records in a Map per entity and interprets the query language in JS.
 * Implements optimistic concurrency via the record `version`. Swap this for a
 * PostgreSQL adapter implementing the same `Repository` interface in production.
 */
import { BadRequestError, ConflictError } from "@/lib/enforcement/errors";
import type { EntityRecord, FieldValue } from "@/lib/metadata/types";
import type { TenantScope } from "@/lib/context/types";
import type { Repository } from "./repository";
import {
  normalizeAggregate,
  type AggregateQuery,
  type AggregateRow,
  type Cursor,
  type DateBucket,
  type Filter,
  type Page,
  type RepoQuery,
  type Sort,
} from "./query";

/**
 * Fold a stored value into a dimension key, mirroring `dialect.dateBucketExpr`.
 *
 * Dates are ISO-8601 strings in both adapters, so bucketing is prefixing here
 * exactly as it is in SQL — the two must agree or a report would change shape
 * between `AULA_PERSISTENCE=memory` and a real database.
 */
function bucketValue(raw: FieldValue | undefined, bucket?: DateBucket): string {
  if (raw === null || raw === undefined) return "";
  const s = String(raw);
  switch (bucket) {
    case "year":
      return s.slice(0, 4);
    case "month":
      return s.slice(0, 7);
    case "day":
      return s.slice(0, 10);
    case "quarter":
      return `${s.slice(0, 4)}-Q${Math.floor((Number(s.slice(5, 7)) + 2) / 3)}`;
    default:
      return s;
  }
}

/**
 * Separator joining a multi-dimension group key.
 *
 * NUL cannot occur in an id, an ISO date or an enum value, so ["a b", "c"] and
 * ["a", "b c"] cannot collide into the same group the way a space or a pipe
 * would let them.
 */
const KEY_SEP = "\u0000";

const HAVING_PREDICATES: Record<string, (a: number, b: number) => boolean> = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
};

function scopeMatch(record: EntityRecord, scope: TenantScope): boolean {
  return record.tenantId === scope.tenantId && record.orgId === scope.orgId;
}

function compare(a: FieldValue, b: FieldValue): number {
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * Compare two record ids the way the database does.
 *
 * Ids are decimal strings here but an INT column in SQL, so ordering them as
 * text puts "10" before "2" — the two adapters would then break a tie in
 * different places, and a cursor minted against one would resume at the wrong
 * row on the other.
 */
function compareIds(a: unknown, b: unknown): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

/**
 * Total order over a result set: the query's sort keys, then `id` ascending.
 *
 * The id is what makes the order TOTAL, and a total order is what paging needs
 * — with ties, "the next page" is not a well-defined set, so a row can appear
 * on two pages or on none. The SQL adapter appends the same tiebreaker; this
 * used to leave the order to `Array.sort`'s stability, which is consistent
 * within a process and does not match the database. Every seeded record shares
 * one `createdAt`, which is also the default sort key, so ties are the norm
 * rather than an edge case.
 */
function orderRows(rows: EntityRecord[], sort: readonly Sort[]): EntityRecord[] {
  const keys = sort.length ? sort : [{ field: "createdAt", dir: "desc" as const }];
  return [...rows].sort((a, b) => {
    for (const s of keys) {
      const c = compare(a[s.field] ?? null, b[s.field] ?? null);
      if (c !== 0) return s.dir === "asc" ? c : -c;
    }
    return compareIds(a.id, b.id);
  });
}

function matchFilter(record: EntityRecord, f: Filter): boolean {
  const v = record[f.field] ?? null;
  switch (f.op) {
    case "eq":
      return v === f.value;
    case "ne":
      return v !== f.value;
    // Ordering comparisons against NULL match NOTHING, as they do in SQL.
    //
    // `compare` treats null as lowest so that SORTING puts it first, matching
    // both engines. Reusing that for a FILTER made `expiresAt < now` true for
    // every row with no expiry at all — so a sweep meant to release lapsed
    // reservations released the ones deliberately set never to lapse. SQL's
    // three-valued logic excludes them; this makes the adapter agree, rather
    // than leaving a divergence that only appears in production.
    case "lt":
      return v !== null && compare(v, f.value as FieldValue) < 0;
    case "lte":
      return v !== null && compare(v, f.value as FieldValue) <= 0;
    case "gt":
      return v !== null && compare(v, f.value as FieldValue) > 0;
    case "gte":
      return v !== null && compare(v, f.value as FieldValue) >= 0;
    case "contains":
      return (
        typeof v === "string" &&
        typeof f.value === "string" &&
        v.toLowerCase().includes(f.value.toLowerCase())
      );
    case "in":
      return Array.isArray(f.value) && (f.value).includes(v);
    default:
      return false;
  }
}

function matchSearch(record: EntityRecord, term: string, fields: string[]): boolean {
  const needle = term.toLowerCase();
  return fields.some((field) => {
    const v = record[field];
    return typeof v === "string" && v.toLowerCase().includes(needle);
  });
}

export class InMemoryRepository implements Repository {
  private collections = new Map<string, Map<string, EntityRecord>>();
  /** Per-entity id counter — emulates `INT IDENTITY(1,1)`. */
  private counters = new Map<string, number>();
  /** Depth of the active transaction (0 = none). Nested tx join the outermost. */
  private txDepth = 0;

  /**
   * Atomic block. Snapshots every collection + counter before running `fn`
   * (records are replaced wholesale on write — never mutated in place — so a
   * shallow Map clone is a faithful point-in-time copy). On throw, restores the
   * snapshot (rollback). Nested calls just run inline under the outer snapshot.
   */
  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.txDepth > 0) return fn(); // join the outer transaction
    const snapCollections = new Map<string, Map<string, EntityRecord>>();
    for (const [k, v] of this.collections) snapCollections.set(k, new Map(v));
    const snapCounters = new Map(this.counters);
    this.txDepth++;
    try {
      const result = await fn();
      return result;
    } catch (e) {
      this.collections = snapCollections; // rollback
      this.counters = snapCounters;
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  private collection(entity: string): Map<string, EntityRecord> {
    let c = this.collections.get(entity);
    if (!c) {
      c = new Map();
      this.collections.set(entity, c);
    }
    return c;
  }

  async list(scope: TenantScope, entity: string, query: RepoQuery): Promise<Page> {
    let rows = [...this.collection(entity).values()].filter((r) => scopeMatch(r, scope));

    for (const f of query.filters) rows = rows.filter((r) => matchFilter(r, f));
    if (query.search && query.search.fields.length) {
      rows = rows.filter((r) => matchSearch(r, query.search!.term, query.search!.fields));
    }

    rows = orderRows(rows, query.sort);

    const total = rows.length;
    const start = (query.page - 1) * query.pageSize;
    const items = rows.slice(start, start + query.pageSize);
    return {
      items,
      total,
      page: query.page,
      pageSize: query.pageSize,
      pageCount: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  /**
   * Keyset page — see the `Repository` contract.
   *
   * Filters, orders and then drops everything up to and including the cursor
   * row. Done by comparing against the same total order rather than by
   * searching for the cursor's id, so a row deleted between pages does not
   * strand the walk: the position is a VALUE, not a row that has to still be
   * there.
   */
  async listAfter(
    scope: TenantScope,
    entity: string,
    query: RepoQuery,
    cursor: Cursor | null,
  ): Promise<{ items: EntityRecord[]; last: EntityRecord | null }> {
    let rows = [...this.collection(entity).values()].filter((r) => scopeMatch(r, scope));
    for (const f of query.filters) rows = rows.filter((r) => matchFilter(r, f));
    if (query.search && query.search.fields.length) {
      rows = rows.filter((r) => matchSearch(r, query.search!.term, query.search!.fields));
    }

    const keys = query.sort.length ? query.sort : [{ field: "createdAt", dir: "desc" as const }];
    rows = orderRows(rows, keys);

    if (cursor) {
      // A synthetic record standing at the cursor's position, compared under the
      // very same ordering the rows were sorted by — so "after" here means
      // exactly what it means in the SQL predicate.
      const at: Record<string, unknown> = { id: cursor.id };
      keys.forEach((s, i) => {
        at[s.field] = cursor.values[i] ?? null;
      });
      rows = rows.filter((r) => {
        for (const s of keys) {
          const c = compare(r[s.field] ?? null, (at[s.field] ?? null) as FieldValue);
          if (c !== 0) return s.dir === "asc" ? c > 0 : c < 0;
        }
        return compareIds(r.id, cursor.id) > 0;
      });
    }

    const items = rows.slice(0, query.pageSize);
    return { items, last: items.length ? items[items.length - 1] ?? null : null };
  }

  async get(scope: TenantScope, entity: string, id: string): Promise<EntityRecord | null> {
    const record = this.collection(entity).get(id);
    if (!record || !scopeMatch(record, scope)) return null;
    return record;
  }

  /**
   * Locking read — a plain filtered read here.
   *
   * Node runs one task at a time and this adapter never awaits mid-operation, so
   * no two "transactions" can interleave between the read and the write that
   * follows it. The lock the SQL adapter takes has nothing to serialise against.
   * The transaction assertion is still enforced so a caller that forgets
   * `runInTransaction` fails the same way it would against a real database.
   */
  async getForUpdate(scope: TenantScope, entity: string, filters: Filter[]): Promise<EntityRecord | null> {
    if (this.txDepth === 0) throw new ConflictError("getForUpdate must be called inside a transaction");
    const rows = [...this.collection(entity).values()].filter(
      (r) => scopeMatch(r, scope) && filters.every((f) => matchFilter(r, f)),
    );
    return rows[0] ?? null;
  }

  async insert(entity: string, record: EntityRecord): Promise<EntityRecord> {
    let stored = record;
    if (record.id) {
      // Explicit id (seeding): keep it, advance the counter past it.
      const n = Number(record.id);
      if (Number.isFinite(n)) this.counters.set(entity, Math.max(this.counters.get(entity) ?? 0, n));
    } else {
      // Runtime create: assign the next sequential int (as a string).
      const next = (this.counters.get(entity) ?? 0) + 1;
      this.counters.set(entity, next);
      stored = { ...record, id: String(next) };
    }
    this.collection(entity).set(stored.id, stored);
    return stored;
  }

  async bulkInsert(entity: string, records: EntityRecord[]): Promise<EntityRecord[]> {
    const out: EntityRecord[] = [];
    for (const record of records) out.push(await this.insert(entity, record));
    return out;
  }

  async update(
    scope: TenantScope,
    entity: string,
    next: EntityRecord,
    expectedVersion?: number,
  ): Promise<EntityRecord> {
    const current = await this.get(scope, entity, next.id);
    if (!current) throw new ConflictError("record no longer exists");
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new ConflictError(
        `version conflict: expected ${expectedVersion} but found ${current.version}`,
      ).withKey("err.versionConflict", { expected: expectedVersion ?? 0, found: current.version ?? 0 });
    }
    this.collection(entity).set(next.id, next);
    return next;
  }

  async delete(scope: TenantScope, entity: string, id: string, expectedVersion?: number): Promise<void> {
    const current = await this.get(scope, entity, id);
    if (!current) return;
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new ConflictError(`version conflict on delete of ${entity} ${id}`).withKey("err.versionConflictDelete", { entity, id });
    }
    this.collection(entity).delete(id);
  }

  async updateMany(scope: TenantScope, entity: string, ids: string[], patch: Record<string, unknown>): Promise<number> {
    let changed = 0;
    for (const id of ids) {
      const current = await this.get(scope, entity, String(id));
      if (!current) continue;
      this.collection(entity).set(current.id, { ...current, ...patch, version: current.version + 1 });
      changed++;
    }
    return changed;
  }

  async deleteMany(scope: TenantScope, entity: string, ids: string[]): Promise<number> {
    let removed = 0;
    for (const id of ids) {
      const current = await this.get(scope, entity, String(id));
      if (!current) continue;
      this.collection(entity).delete(current.id);
      removed++;
    }
    return removed;
  }

  async existsByField(
    scope: TenantScope,
    entity: string,
    field: string,
    value: unknown,
    exceptId?: string,
  ): Promise<boolean> {
    for (const r of this.collection(entity).values()) {
      if (scopeMatch(r, scope) && r[field] === value && r.id !== exceptId) return true;
    }
    return false;
  }

  /** Test/seed helper: total rows across all tenants for an entity. */
  size(entity: string): number {
    return this.collection(entity).size;
  }

  async aggregate(scope: TenantScope, entity: string, query: AggregateQuery): Promise<AggregateRow[]> {
    // Same `normalizeAggregate` as the SQL adapter, so the two cannot drift on
    // what `groupBy` vs `dimensions` means or what the defaults are.
    const q = normalizeAggregate(query);
    let rows = [...this.collection(entity).values()].filter((r) => scopeMatch(r, scope));
    for (const f of q.filters) rows = rows.filter((r) => matchFilter(r, f));

    // Group on the joined dimension values; `parts` keeps the per-dimension
    // values so they can be handed back individually.
    const groups = new Map<string, { parts: string[]; rows: EntityRecord[] }>();
    for (const r of rows) {
      const parts = q.dimensions.map((d) => bucketValue(r[d.field], d.bucket));
      const key = parts.join(KEY_SEP);
      const bucket = groups.get(key) ?? { parts, rows: [] };
      bucket.rows.push(r);
      groups.set(key, bucket);
    }
    // An ungrouped aggregate always yields exactly one (possibly empty) row.
    if (q.dimensions.length === 0 && groups.size === 0) groups.set("", { parts: [], rows: [] });

    let result: AggregateRow[] = [];
    for (const { parts, rows: bucket } of groups.values()) {
      const measures: Record<string, number> = {};
      for (const m of q.measures) {
        if (m.op === "count") {
          measures[m.as] = bucket.length;
          continue;
        }
        if (m.op === "countDistinct") {
          measures[m.as] = new Set(
            bucket.map((r) => r[m.field as string]).filter((v) => v !== null && v !== undefined),
          ).size;
          continue;
        }
        const values = bucket
          .map((r) => r[m.field as string])
          .filter((v): v is number => typeof v === "number");
        if (m.op === "sum") measures[m.as] = values.reduce((s, v) => s + v, 0);
        else if (m.op === "avg") measures[m.as] = values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
        else if (m.op === "min") measures[m.as] = values.length ? Math.min(...values) : 0;
        else if (m.op === "max") measures[m.as] = values.length ? Math.max(...values) : 0;
      }
      const keys: Record<string, string | null> = {};
      q.dimensions.forEach((d, i) => {
        keys[d.as] = parts[i] ?? "";
      });
      const first = q.dimensions[0];
      result.push({ key: first ? keys[first.as] ?? null : null, keys, measures });
    }

    for (const h of q.having) {
      const op = HAVING_PREDICATES[h.op];
      if (!op) throw new BadRequestError(`unsupported having operator "${h.op}"`);
      result = result.filter((r) => op(r.measures[h.measure] ?? 0, h.value));
    }

    if (q.sort.length) {
      result.sort((a, b) => {
        for (const s of q.sort) {
          const dim = q.dimensions.find((d) => d.as === s.by || d.field === s.by);
          const av = dim ? a.keys[dim.as] ?? "" : a.measures[s.by] ?? 0;
          const bv = dim ? b.keys[dim.as] ?? "" : b.measures[s.by] ?? 0;
          if (av === bv) continue;
          const cmp = av < bv ? -1 : 1;
          return s.dir === "desc" ? -cmp : cmp;
        }
        return 0;
      });
    } else if (q.dimensions.length) {
      // Match the SQL adapter's implicit ordering by dimension key.
      result.sort((a, b) => (a.key ?? "") < (b.key ?? "") ? -1 : (a.key ?? "") > (b.key ?? "") ? 1 : 0);
    }

    return result.slice(0, q.limit);
  }

  /** System-level scan across every collection (used for search reindex). */
  scanAll(): { entity: string; record: EntityRecord }[] {
    const out: { entity: string; record: EntityRecord }[] = [];
    for (const [entity, collection] of this.collections) {
      for (const record of collection.values()) out.push({ entity, record });
    }
    return out;
  }
}
