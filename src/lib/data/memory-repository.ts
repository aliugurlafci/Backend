/**
 * Phase 5 — In-memory repository adapter (default backend).
 *
 * Stores records in a Map per entity and interprets the query language in JS.
 * Implements optimistic concurrency via the record `version`. Swap this for a
 * PostgreSQL adapter implementing the same `Repository` interface in production.
 */
import { ConflictError } from "@/lib/enforcement/errors";
import type { EntityRecord, FieldValue } from "@/lib/metadata/types";
import type { TenantScope } from "@/lib/context/types";
import type { Repository } from "./repository";
import type { AggregateQuery, AggregateRow, Filter, Page, RepoQuery } from "./query";

function scopeMatch(record: EntityRecord, scope: TenantScope): boolean {
  return record.tenantId === scope.tenantId && record.orgId === scope.orgId;
}

function compare(a: FieldValue, b: FieldValue): number {
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function matchFilter(record: EntityRecord, f: Filter): boolean {
  const v = record[f.field] ?? null;
  switch (f.op) {
    case "eq":
      return v === f.value;
    case "ne":
      return v !== f.value;
    case "lt":
      return compare(v, f.value as FieldValue) < 0;
    case "lte":
      return compare(v, f.value as FieldValue) <= 0;
    case "gt":
      return compare(v, f.value as FieldValue) > 0;
    case "gte":
      return compare(v, f.value as FieldValue) >= 0;
    case "contains":
      return (
        typeof v === "string" &&
        typeof f.value === "string" &&
        v.toLowerCase().includes(f.value.toLowerCase())
      );
    case "in":
      return Array.isArray(f.value) && (f.value as FieldValue[]).includes(v);
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

    for (const s of [...query.sort].reverse()) {
      rows.sort((a, b) => {
        const c = compare(a[s.field] ?? null, b[s.field] ?? null);
        return s.dir === "asc" ? c : -c;
      });
    }

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

  async get(scope: TenantScope, entity: string, id: string): Promise<EntityRecord | null> {
    const record = this.collection(entity).get(id);
    if (!record || !scopeMatch(record, scope)) return null;
    return record;
  }

  async insert(record: EntityRecord): Promise<EntityRecord> {
    // ids are formatted `<entity>_<uuid>`, so the prefix names the collection.
    this.collection(entityFromId(record)).set(record.id, record);
    return record;
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
      );
    }
    this.collection(entity).set(next.id, next);
    return next;
  }

  async delete(scope: TenantScope, entity: string, id: string, expectedVersion?: number): Promise<void> {
    const current = await this.get(scope, entity, id);
    if (!current) return;
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new ConflictError(`version conflict on delete of ${entity} ${id}`);
    }
    this.collection(entity).delete(id);
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
    let rows = [...this.collection(entity).values()].filter((r) => scopeMatch(r, scope));
    for (const f of query.filters ?? []) rows = rows.filter((r) => matchFilter(r, f));

    const groups = new Map<string | null, EntityRecord[]>();
    for (const r of rows) {
      const key = query.groupBy ? (r[query.groupBy] === null || r[query.groupBy] === undefined ? "" : String(r[query.groupBy])) : null;
      const bucket = groups.get(key) ?? [];
      bucket.push(r);
      groups.set(key, bucket);
    }
    if (!query.groupBy && groups.size === 0) groups.set(null, []);

    const result: AggregateRow[] = [];
    for (const [key, bucket] of groups) {
      const measures: Record<string, number> = {};
      for (const m of query.measures) {
        if (m.op === "count") {
          measures[m.as] = bucket.length;
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
      result.push({ key, measures });
    }
    return result;
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

function entityFromId(record: EntityRecord): string {
  // ids are formatted `<entity>_<uuid>`; fall back to a stored hint.
  const prefix = record.id.split("_")[0];
  return prefix || "unknown";
}
