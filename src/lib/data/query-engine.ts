/**
 * Phase 5 — Unified, enforcement-first query engine.
 *
 * The single gateway through which all data flows. Every operation:
 *  - is scoped to the caller's tenant/org (isolation),
 *  - is authorized by the permission engine (object/record/field),
 *  - validates writes against published metadata,
 *  - enforces unique constraints and optimistic concurrency,
 *  - and projects out fields the caller may not read.
 *
 * Higher layers (domain services, API) never touch the repository directly.
 */
import { systemClock, type Clock } from "@/lib/core/clock";
import {
  assertAllowed,
  assertFound,
  assertValid,
  BadRequestError,
  ConflictError,
} from "@/lib/enforcement";
import { scopeOf } from "@/lib/context/isolation";
import type { RequestContext } from "@/lib/context/types";
import type { MetadataResolver } from "@/lib/metadata/resolver";
import { buildCreateSchema, buildUpdateSchema, validateRecord } from "@/lib/metadata/validation";
import type { EntityDef, EntityRecord, FieldValue } from "@/lib/metadata/types";
import type { PermissionEngine } from "@/lib/permissions/engine";
import type { Repository } from "./repository";
import {
  decodeCursor,
  encodeCursor,
  INTERNAL_MAX_PAGE_SIZE,
  MAX_PAGE_SIZE,
  normalizePaging,
  sortFingerprint,
  type AggregateQuery,
  type AggregateRow,
  type CursorPage,
  type Filter,
  type Page,
  type Query,
  type RepoQuery,
} from "./query";

export interface UpdateOptions {
  expectedVersion?: number;
  /** Internal: permit changing the lifecycle field (used by domain transitions). */
  allowLifecycleField?: boolean;
}

export interface ListOptions {
  /**
   * Raise the page-size ceiling above `MAX_PAGE_SIZE` for an internal read that
   * must see a whole working set rather than a page — every line of a document
   * being posted, every closed fiscal period, the ids needed to label an export.
   *
   * HTTP handlers never pass this: a request asking for more than `MAX_PAGE_SIZE`
   * is rejected at the edge, so the only way to exceed the cap is a deliberate
   * service-layer call. Hard-capped at `INTERNAL_MAX_PAGE_SIZE`; a working set
   * that can legitimately outgrow that belongs in `listAll`, which streams.
   */
  maxPageSize?: number;
}

/** Which of an entity's fields may be filtered, sorted and searched on. */
interface QueryShape {
  fieldNames: Set<string>;
  filterable: Set<string>;
  sortable: Set<string>;
  searchFields: string[];
}

/**
 * Per-entity query shape, derived once instead of on every list call.
 *
 * The sets come purely from the entity's field flags, so they are stable for the
 * lifetime of a metadata version. Keyed on the definition *object*, which a new
 * version replaces — so a republish naturally yields a fresh entry and the old
 * one is collected with the old definition.
 */
/**
 * Columns every table has that no `EntityDef` declares.
 *
 * `tenantId` and `orgId` are deliberately absent: those are scoping, applied by
 * the repository from the request context, and a caller-supplied filter on them
 * has no legitimate use — only an illegitimate one.
 */
const SYSTEM_FIELD_NAMES = ["id", "ownerId", "createdAt", "updatedAt", "createdBy", "updatedBy", "version"] as const;

const queryShapes = new WeakMap<EntityDef, QueryShape>();

function queryShape(entity: EntityDef): QueryShape {
  const cached = queryShapes.get(entity);
  if (cached) return cached;
  const shape: QueryShape = {
    // The SYSTEM columns belong here too.
    //
    // They are real columns on every table, but they are not in `entity.fields`
    // — so a filter or sort naming one was silently DROPPED and the query ran
    // unfiltered. `listByIds` is built entirely on `{field: "id", op: "in"}`,
    // which meant it returned the first page of the table rather than the rows
    // asked for: every name it resolved was whichever record happened to sort
    // first. On a small table the answer looks right, which is why this went
    // unnoticed. Sorting by `createdAt` — which several list routes ask for —
    // was being dropped the same way.
    //
    // Safe to allow: the repository still whitelists every field against the
    // column map derived from this same schema, so nothing new is reachable,
    // and tenant scoping is applied separately from the caller's filters.
    fieldNames: new Set([...SYSTEM_FIELD_NAMES, ...entity.fields.map((f) => f.name)]),
    filterable: new Set([...SYSTEM_FIELD_NAMES, ...entity.fields.filter((f) => f.filterable).map((f) => f.name)]),
    sortable: new Set([...SYSTEM_FIELD_NAMES, ...entity.fields.filter((f) => f.sortable).map((f) => f.name)]),
    searchFields: entity.fields.filter((f) => f.searchable).map((f) => f.name),
  };
  queryShapes.set(entity, shape);
  return shape;
}

export class QueryEngine {
  constructor(
    private readonly repo: Repository,
    private readonly metadata: MetadataResolver,
    private readonly permissions: PermissionEngine,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Run a unit of work atomically (all writes commit together, or none do).
   * Services wrap multi-step financial/inventory flows in this so a mid-way
   * failure can never leave the GL, sub-ledgers and stock ledger inconsistent.
   */
  runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.repo.runInTransaction(fn);
  }

  // ---- reads -------------------------------------------------------------

  async list(
    ctx: RequestContext,
    entityName: string,
    query: Query = {},
    opts: ListOptions = {},
  ): Promise<Page> {
    const entity = this.metadata.getEntity(entityName);
    assertAllowed(this.permissions.evaluate(ctx, { action: `${entityName}:read`, entity: entityName }));

    const page = await this.repo.list(scopeOf(ctx), entityName, this.toRepoQuery(entity, query, opts));
    return { ...page, items: page.items.map((r) => this.project(ctx, entity, r)) };
  }

  /**
   * One keyset page — resume after `cursor`, or start at the beginning.
   *
   * The same permission check and field projection as `list`; only the way the
   * position is expressed differs. There is no `total`, deliberately: producing
   * one costs the whole-set scan this exists to avoid.
   */
  async listByCursor(
    ctx: RequestContext,
    entityName: string,
    query: Query = {},
    rawCursor?: string,
    opts: ListOptions = {},
  ): Promise<CursorPage> {
    const entity = this.metadata.getEntity(entityName);
    assertAllowed(this.permissions.evaluate(ctx, { action: `${entityName}:read`, entity: entityName }));

    const repoQuery = this.toRepoQuery(entity, query, opts);
    const sort = repoQuery.sort.length ? repoQuery.sort : [{ field: "createdAt", dir: "desc" as const }];
    const fingerprint = sortFingerprint(sort);

    const cursor = decodeCursor(rawCursor, fingerprint);
    // A cursor that was minted under a different sort is refused rather than
    // ignored. Ignoring it would restart the walk from the top, silently
    // re-delivering everything the caller already has.
    if (rawCursor && !cursor) {
      throw new BadRequestError("cursor does not match this query's sort order; restart without a cursor");
    }

    const { items, last } = await this.repo.listAfter(scopeOf(ctx), entityName, repoQuery, cursor);
    // A full page might still be the last one; the caller finds out by asking
    // again and getting nothing. Minting a cursor only for full pages avoids one
    // wasted round trip in the common case without ever claiming there is more
    // when there is not.
    const nextCursor =
      last && items.length === repoQuery.pageSize
        ? encodeCursor({
            values: sort.map((s) => last[s.field] ?? null),
            id: String(last.id),
            sort: fingerprint,
          })
        : undefined;

    return {
      items: items.map((r) => this.project(ctx, entity, r)),
      ...(nextCursor ? { nextCursor } : {}),
      pageSize: repoQuery.pageSize,
    };
  }

  /**
   * Stream every record matching `query`, a page at a time, invoking `onPage`
   * for each batch. For working sets with no meaningful upper bound — exporting
   * an entity, rebuilding the search index — where a single large page is a
   * memory and timeout problem whatever the cap is set to.
   *
   * Pages are read at `INTERNAL_MAX_PAGE_SIZE` unless `query.pageSize` asks for
   * less. `query.page` is ignored: a walk always starts at the beginning.
   *
   * Walks by CURSOR, not by offset. Offset paging over a table that is being
   * written to is not merely slower — it is wrong: every insert before the
   * current position shifts the remaining rows down, so the next page starts
   * one row late and the row that moved across the boundary is never read. On
   * the two callers this has — the export endpoint and the search reindex —
   * that means a file that is quietly short and records nobody can find. It was
   * also O(n²): the database produced and discarded every preceding row on each
   * page, and computed a `COUNT(*) OVER()` alongside.
   *
   * A cursor is still not a snapshot: a row inserted BEHIND the current
   * position is not seen, and one updated so that it sorts backwards can be
   * read twice. That is acceptable for an export or an index rebuild, and is
   * not a basis for anything that must balance.
   */
  async listAll(
    ctx: RequestContext,
    entityName: string,
    query: Query = {},
    onPage: (items: EntityRecord[]) => void | Promise<void>,
  ): Promise<number> {
    const pageSize = Math.min(query.pageSize ?? INTERNAL_MAX_PAGE_SIZE, INTERNAL_MAX_PAGE_SIZE);
    let cursor: string | undefined;
    let seen = 0;
    for (;;) {
      const result = await this.listByCursor(ctx, entityName, { ...query, pageSize }, cursor, {
        maxPageSize: pageSize,
      });
      if (result.items.length > 0) {
        await onPage(result.items);
        seen += result.items.length;
      }
      if (!result.nextCursor) return seen;
      cursor = result.nextCursor;
    }
  }

  /**
   * Read records by id — for resolving the names behind a set of foreign keys.
   *
   * Chunked because an `IN (…)` list becomes one bind parameter per id, and
   * MSSQL caps a statement at 2,100 of them. Duplicates are collapsed and the
   * result is unordered; callers index it by id.
   *
   * This is the alternative to "read the whole table and build a Map", which is
   * what several handlers did — and which quietly stopped resolving names once
   * the table outgrew the page cap.
   */
  async listByIds(ctx: RequestContext, entityName: string, ids: string[]): Promise<EntityRecord[]> {
    const unique = [...new Set(ids.map(String).filter((id) => id !== ""))];
    if (unique.length === 0) return [];
    const CHUNK = 500;
    const out: EntityRecord[] = [];
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK);
      const page = await this.list(
        ctx,
        entityName,
        { filters: [{ field: "id", op: "in", value: chunk }], page: 1, pageSize: chunk.length },
        { maxPageSize: chunk.length },
      );
      out.push(...page.items);
    }
    return out;
  }

  /**
   * Read a complete working set in one call, raising if it does not fit.
   *
   * For reads whose correctness depends on seeing *every* row: the lines of a
   * document being posted to the ledger, the closed periods guarding a date.
   * Returning a page here is how the 201st invoice line went missing from its
   * journal entry — so this fails loudly instead of truncating.
   *
   * `INTERNAL_MAX_PAGE_SIZE` is the ceiling. A collection that can legitimately
   * exceed it is not a working set; stream it with `listAll` instead.
   */
  async listComplete(ctx: RequestContext, entityName: string, query: Query = {}): Promise<EntityRecord[]> {
    const pageSize = Math.min(query.pageSize ?? INTERNAL_MAX_PAGE_SIZE, INTERNAL_MAX_PAGE_SIZE);
    const page = await this.list(
      ctx,
      entityName,
      { ...query, page: 1, pageSize },
      { maxPageSize: pageSize },
    );
    if (page.total > page.items.length) {
      throw new ConflictError(
        `Cannot read all ${entityName} records in one page (${page.total} > ${pageSize}). ` +
          `This read must see every row; use a streaming read instead.`,
      );
    }
    return page.items;
  }

  /** Grouped aggregation (reports/dashboards) — read-permission gated + scoped. */
  async aggregate(ctx: RequestContext, entityName: string, query: AggregateQuery): Promise<AggregateRow[]> {
    this.metadata.getEntity(entityName);
    assertAllowed(this.permissions.evaluate(ctx, { action: `${entityName}:read`, entity: entityName }));
    return this.repo.aggregate(scopeOf(ctx), entityName, query);
  }

  /**
   * Locking read for a read-then-write sequence — see `Repository.getForUpdate`.
   *
   * Internal: returns the raw row with no field projection, because callers need
   * `version` and the numeric columns they are about to update. Still gated on
   * read permission and tenant scope.
   */
  async getForUpdate(
    ctx: RequestContext,
    entityName: string,
    filters: Filter[],
  ): Promise<EntityRecord | null> {
    this.metadata.getEntity(entityName);
    assertAllowed(this.permissions.evaluate(ctx, { action: `${entityName}:read`, entity: entityName }));
    return this.repo.getForUpdate(scopeOf(ctx), entityName, filters);
  }

  async get(ctx: RequestContext, entityName: string, id: string): Promise<EntityRecord> {
    const entity = this.metadata.getEntity(entityName);
    assertAllowed(this.permissions.evaluate(ctx, { action: `${entityName}:read`, entity: entityName }));

    const record = await this.repo.get(scopeOf(ctx), entityName, id);
    assertFound(record, entity.label, id);
    return this.project(ctx, entity, record);
  }

  // ---- writes ------------------------------------------------------------

  async create(ctx: RequestContext, entityName: string, input: unknown): Promise<EntityRecord> {
    const entity = this.metadata.getEntity(entityName);
    assertAllowed(this.permissions.evaluate(ctx, { action: `${entityName}:create`, entity: entityName }));

    const outcome = validateRecord(buildCreateSchema(entity), input ?? {});
    assertValid(outcome);
    const values = this.applyDefaults(entity, outcome.data ?? {});
    await this.assertUnique(ctx, entity, values);

    const now = this.clock.isoNow();
    const record: EntityRecord = {
      id: "", // assigned by the store (DB IDENTITY / in-memory counter)
      tenantId: ctx.tenantId,
      orgId: ctx.orgId,
      ownerId: entity.ownable ? ctx.userId : null,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
      ...values,
    };
    const saved = await this.repo.insert(entityName, record);
    return this.project(ctx, entity, saved);
  }

  /**
   * Create a record, then merge server-computed fields (e.g. document number,
   * totals) that clients may not set. Validates user input as usual.
   */
  async createWithComputed(
    ctx: RequestContext,
    entityName: string,
    input: unknown,
    computed: Record<string, FieldValue>,
  ): Promise<EntityRecord> {
    const entity = this.metadata.getEntity(entityName);
    assertAllowed(this.permissions.evaluate(ctx, { action: `${entityName}:create`, entity: entityName }));
    const outcome = validateRecord(buildCreateSchema(entity), input ?? {});
    assertValid(outcome);
    const values = { ...this.applyDefaults(entity, outcome.data ?? {}), ...computed };
    await this.assertUnique(ctx, entity, values);

    const now = this.clock.isoNow();
    const record: EntityRecord = {
      id: "", // assigned by the store (DB IDENTITY / in-memory counter)
      tenantId: ctx.tenantId,
      orgId: ctx.orgId,
      ownerId: entity.ownable ? ctx.userId : null,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
      ...values,
    };
    const saved = await this.repo.insert(entityName, record);
    return this.project(ctx, entity, saved);
  }

  /**
   * Bulk-create many records efficiently (CSV/Excel import). Unlike calling
   * `create` per row, this:
   *  - checks `create` permission and builds the validation schema ONCE,
   *  - preloads existing unique-field values in a single aggregate per field
   *    (O(n) instead of an `existsByField` scan per row → O(n²)),
   *  - dedupes unique values WITHIN the batch as it goes,
   *  - and (crucially) does NOT emit per-record domain events — so importing
   *    20k rows doesn't fire 20k automations / search re-indexes / webhooks.
   * Per-row validation / uniqueness failures are collected (by input index)
   * rather than aborting the batch.
   */
  async bulkCreate(
    ctx: RequestContext,
    entityName: string,
    inputs: Record<string, unknown>[],
  ): Promise<{ created: EntityRecord[]; errors: { index: number; message: string }[] }> {
    const entity = this.metadata.getEntity(entityName);
    assertAllowed(this.permissions.evaluate(ctx, { action: `${entityName}:create`, entity: entityName }));
    const schema = buildCreateSchema(entity);
    const uniqueFields = entity.fields.filter((f) => f.unique);

    // Preload existing unique values once (distinct-by-group) → O(n), not O(n²).
    const seen = new Map<string, Set<string>>();
    for (const f of uniqueFields) {
      const rows = await this.repo.aggregate(scopeOf(ctx), entityName, {
        groupBy: f.name,
        measures: [{ op: "count", as: "c" }],
      });
      seen.set(f.name, new Set(rows.map((r) => (r.key == null ? "" : String(r.key))).filter((k) => k !== "")));
    }

    const errors: { index: number; message: string }[] = [];
    const pending: { index: number; record: EntityRecord }[] = [];
    const now = this.clock.isoNow();

    inputs.forEach((input, index) => {
      const outcome = validateRecord(schema, input ?? {});
      if (!outcome.success) {
        const detail = (outcome.issues ?? []).map((i) => `${i.field}: ${i.message}`).join("; ");
        errors.push({ index, message: `Validation failed${detail ? ` — ${detail}` : ""}` });
        return;
      }
      const values = this.applyDefaults(entity, outcome.data ?? {});
      const conflict = uniqueFields.find((f) => {
        const v = values[f.name];
        return v != null && v !== "" && seen.get(f.name)!.has(String(v));
      });
      if (conflict) {
        errors.push({
          index,
          message: `${entity.label} with ${conflict.label} "${String(values[conflict.name])}" already exists — ${conflict.name}: must be unique`,
        });
        return;
      }
      for (const f of uniqueFields) {
        const v = values[f.name];
        if (v != null && v !== "") seen.get(f.name)!.add(String(v));
      }
      pending.push({
        index,
        record: {
          id: "",
          tenantId: ctx.tenantId,
          orgId: ctx.orgId,
          ownerId: entity.ownable ? ctx.userId : null,
          createdAt: now,
          updatedAt: now,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
          version: 1,
          ...values,
        },
      });
    });

    // Write in bulk: a handful of chunked multi-row INSERTs instead of one
    // round-trip per row (a 20k-row import was 20k serial inserts → HTTP
    // timeout). If a chunk fails on a DB-level constraint not caught above, we
    // retry that chunk row-by-row to attribute the error to the offending row
    // and let its neighbours still land (partial-success semantics preserved).
    const created: EntityRecord[] = [];
    const CHUNK = 500;
    for (let i = 0; i < pending.length; i += CHUNK) {
      const group = pending.slice(i, i + CHUNK);
      try {
        created.push(...(await this.repo.bulkInsert(entityName, group.map((p) => p.record))));
      } catch {
        for (const p of group) {
          try {
            created.push(await this.repo.insert(entityName, p.record));
          } catch (e) {
            errors.push({ index: p.index, message: e instanceof Error ? e.message : String(e) });
          }
        }
      }
    }
    return { created, errors };
  }

  /**
   * Internal: write server-computed fields onto an existing record without
   * re-validating user input (used by the finance service to store totals).
   */
  async patchComputed(
    ctx: RequestContext,
    entityName: string,
    id: string,
    computed: Record<string, FieldValue>,
    /** When given, the write is version-guarded (optimistic lock): a concurrent
     *  modification since the caller read the record raises a ConflictError. */
    expectedVersion?: number,
  ): Promise<EntityRecord> {
    const entity = this.metadata.getEntity(entityName);
    const current = await this.repo.get(scopeOf(ctx), entityName, id);
    assertFound(current, entity.label, id);
    const next: EntityRecord = {
      ...current,
      ...computed,
      updatedAt: this.clock.isoNow(),
      updatedBy: ctx.userId,
      version: current.version + 1,
    };
    return this.repo.update(scopeOf(ctx), entityName, next, expectedVersion);
  }

  async update(
    ctx: RequestContext,
    entityName: string,
    id: string,
    patch: unknown,
    options: UpdateOptions = {},
  ): Promise<EntityRecord> {
    const entity = this.metadata.getEntity(entityName);
    const current = await this.repo.get(scopeOf(ctx), entityName, id);
    assertFound(current, entity.label, id);

    assertAllowed(
      this.permissions.evaluate(ctx, {
        action: `${entityName}:update`,
        entity: entityName,
        recordOwnerId: current.ownerId,
      }),
    );

    const outcome = validateRecord(buildUpdateSchema(entity), patch ?? {});
    assertValid(outcome);
    const changes = outcome.data ?? {};

    if (!options.allowLifecycleField && entity.lifecycle) {
      const field = entity.lifecycle.field;
      if (field in changes && changes[field] !== current[field]) {
        throw new ConflictError(
          `"${field}" is lifecycle-managed; use a transition action instead of a direct update`,
        ).withKey("err.lifecycleManagedField", { field });
      }
    }

    await this.assertUnique(ctx, entity, changes, id);

    const next: EntityRecord = {
      ...current,
      ...(changes as Record<string, FieldValue>),
      id: current.id,
      tenantId: current.tenantId,
      orgId: current.orgId,
      ownerId: current.ownerId,
      createdAt: current.createdAt,
      createdBy: current.createdBy,
      updatedAt: this.clock.isoNow(),
      updatedBy: ctx.userId,
      version: current.version + 1,
    };
    const saved = await this.repo.update(scopeOf(ctx), entityName, next, options.expectedVersion);
    return this.project(ctx, entity, saved);
  }

  async remove(ctx: RequestContext, entityName: string, id: string, expectedVersion?: number): Promise<void> {
    const entity = this.metadata.getEntity(entityName);
    const current = await this.repo.get(scopeOf(ctx), entityName, id);
    assertFound(current, entity.label, id);
    assertAllowed(
      this.permissions.evaluate(ctx, {
        action: `${entityName}:delete`,
        entity: entityName,
        recordOwnerId: current.ownerId,
      }),
    );
    await this.repo.delete(scopeOf(ctx), entityName, id, expectedVersion);
  }

  /**
   * Bulk-apply a validated partial patch to many records in one round-trip.
   * Requires a manage-any update grant (no per-record ownership check), so it is
   * meant for entities the caller can manage broadly (e.g. their mailbox).
   */
  async updateMany(ctx: RequestContext, entityName: string, ids: string[], patch: unknown): Promise<number> {
    if (ids.length === 0) return 0;
    const entity = this.metadata.getEntity(entityName);
    assertAllowed(this.permissions.evaluate(ctx, { action: `${entityName}:update`, entity: entityName }));
    const outcome = validateRecord(buildUpdateSchema(entity), patch ?? {});
    assertValid(outcome);
    const changes = outcome.data ?? {};
    if (entity.lifecycle && entity.lifecycle.field in changes) {
      throw new ConflictError(`"${entity.lifecycle.field}" is lifecycle-managed; use a transition action`).withKey("err.lifecycleManagedField", { field: entity.lifecycle.field });
    }
    const full: Record<string, FieldValue> = {
      ...(changes as Record<string, FieldValue>),
      updatedAt: this.clock.isoNow(),
      updatedBy: ctx.userId,
    };
    return this.repo.updateMany(scopeOf(ctx), entityName, ids.map(String), full);
  }

  /** Bulk-delete many records by id in one round-trip (manage-any delete grant). */
  async removeMany(ctx: RequestContext, entityName: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    this.metadata.getEntity(entityName); // assert the entity exists
    assertAllowed(this.permissions.evaluate(ctx, { action: `${entityName}:delete`, entity: entityName }));
    return this.repo.deleteMany(scopeOf(ctx), entityName, ids.map(String));
  }

  // ---- helpers -----------------------------------------------------------

  private toRepoQuery(entity: EntityDef, query: Query, opts: ListOptions = {}): RepoQuery {
    const { fieldNames, filterable, sortable, searchFields } = queryShape(entity);
    const { page, pageSize } = normalizePaging(query, {
      max: opts.maxPageSize ?? MAX_PAGE_SIZE,
    });

    return {
      page,
      pageSize,
      filters: (query.filters ?? []).filter((f) => filterable.has(f.field) || fieldNames.has(f.field)),
      sort: (query.sort ?? []).filter((s) => sortable.has(s.field)),
      search: query.search ? { term: query.search, fields: searchFields } : undefined,
    };
  }

  private applyDefaults(entity: EntityDef, values: Record<string, unknown>): Record<string, FieldValue> {
    const out: Record<string, FieldValue> = {};
    for (const field of entity.fields) {
      const provided = values[field.name];
      if (provided !== undefined && provided !== null) {
        out[field.name] = provided as FieldValue;
      } else if (field.defaultValue !== undefined) {
        out[field.name] = field.defaultValue as FieldValue;
      } else {
        out[field.name] = null;
      }
    }
    if (entity.lifecycle && (out[entity.lifecycle.field] === null || out[entity.lifecycle.field] === undefined)) {
      out[entity.lifecycle.field] = entity.lifecycle.initial;
    }
    return out;
  }

  /**
   * Reject a write that would duplicate a unique field.
   *
   * This is a courtesy check, not the guarantee: the tenant-scoped unique
   * indexes are, and the repository translates a violation from them into the
   * same error. Two concurrent creates can both pass here and only one reach the
   * index — which is exactly why the database has the final say.
   *
   * The checks run together rather than one after another (a write used to cost
   * one round trip per unique field), but the reported field is still the first
   * in declaration order, so the same input always produces the same message.
   */
  private async assertUnique(
    ctx: RequestContext,
    entity: EntityDef,
    values: Record<string, unknown>,
    exceptId?: string,
  ): Promise<void> {
    const checks = entity.fields
      .filter((f) => f.unique && values[f.name] !== undefined && values[f.name] !== null)
      .map(async (field) => ({
        field,
        taken: await this.repo.existsByField(scopeOf(ctx), entity.name, field.name, values[field.name], exceptId),
      }));
    if (checks.length === 0) return;

    const results = await Promise.all(checks);
    const clash = results.find((r) => r.taken);
    if (clash) {
      const value = values[clash.field.name];
      throw new ConflictError(`${entity.label} with ${clash.field.label} "${String(value)}" already exists`, [
        { field: clash.field.name, message: "must be unique" },
      ]).withKey("err.uniqueClash", { entity: entity.name, field: clash.field.name, value: String(value) });
    }
  }

  /**
   * Drop fields the caller may not read (field-level enforcement).
   *
   * Which fields those are is identical for every record of a page, so ask for
   * the denied list (cached per identity + entity) and delete only those —
   * instead of re-deciding all fields, per record.
   */
  private project(ctx: RequestContext, entity: EntityDef, record: EntityRecord): EntityRecord {
    const denied = this.permissions.deniedFields(ctx, entity);
    const out = { ...record };
    for (const field of denied) delete out[field];
    return out;
  }
}
