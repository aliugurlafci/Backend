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
import { newId } from "@/lib/core/ids";
import { systemClock, type Clock } from "@/lib/core/clock";
import {
  assertAllowed,
  assertFound,
  assertValid,
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
  normalizePaging,
  type AggregateQuery,
  type AggregateRow,
  type Page,
  type Query,
  type RepoQuery,
} from "./query";

export interface UpdateOptions {
  expectedVersion?: number;
  /** Internal: permit changing the lifecycle field (used by domain transitions). */
  allowLifecycleField?: boolean;
}

export class QueryEngine {
  constructor(
    private readonly repo: Repository,
    private readonly metadata: MetadataResolver,
    private readonly permissions: PermissionEngine,
    private readonly clock: Clock = systemClock,
  ) {}

  // ---- reads -------------------------------------------------------------

  async list(ctx: RequestContext, entityName: string, query: Query = {}): Promise<Page> {
    const entity = this.metadata.getEntity(entityName);
    assertAllowed(this.permissions.evaluate(ctx, { action: `${entityName}:read`, entity: entityName }));

    const page = await this.repo.list(scopeOf(ctx), entityName, this.toRepoQuery(entity, query));
    return { ...page, items: page.items.map((r) => this.project(ctx, entity, r)) };
  }

  /** Grouped aggregation (reports/dashboards) — read-permission gated + scoped. */
  async aggregate(ctx: RequestContext, entityName: string, query: AggregateQuery): Promise<AggregateRow[]> {
    this.metadata.getEntity(entityName);
    assertAllowed(this.permissions.evaluate(ctx, { action: `${entityName}:read`, entity: entityName }));
    return this.repo.aggregate(scopeOf(ctx), entityName, query);
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
    const id = newId(entityName);
    const record: EntityRecord = {
      id,
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
    await this.repo.insert(record);
    return this.project(ctx, entity, record);
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
      id: newId(entityName),
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
    await this.repo.insert(record);
    return this.project(ctx, entity, record);
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
    return this.repo.update(scopeOf(ctx), entityName, next);
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
        );
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

  // ---- helpers -----------------------------------------------------------

  private toRepoQuery(entity: EntityDef, query: Query): RepoQuery {
    const fieldNames = new Set(entity.fields.map((f) => f.name));
    const filterable = new Set(entity.fields.filter((f) => f.filterable).map((f) => f.name));
    const sortable = new Set(entity.fields.filter((f) => f.sortable).map((f) => f.name));
    const searchFields = entity.fields.filter((f) => f.searchable).map((f) => f.name);
    const { page, pageSize } = normalizePaging(query);

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

  private async assertUnique(
    ctx: RequestContext,
    entity: EntityDef,
    values: Record<string, unknown>,
    exceptId?: string,
  ): Promise<void> {
    for (const field of entity.fields) {
      if (!field.unique) continue;
      const value = values[field.name];
      if (value === undefined || value === null) continue;
      if (await this.repo.existsByField(scopeOf(ctx), entity.name, field.name, value, exceptId)) {
        throw new ConflictError(`${entity.label} with ${field.label} "${value}" already exists`, [
          { field: field.name, message: "must be unique" },
        ]);
      }
    }
  }

  /** Drop fields the caller may not read (field-level enforcement). */
  private project(ctx: RequestContext, entity: EntityDef, record: EntityRecord): EntityRecord {
    const readable = new Set(this.permissions.readableFields(ctx, entity));
    const out = { ...record };
    for (const field of entity.fields) {
      if (!readable.has(field.name)) delete out[field.name];
    }
    return out;
  }
}
