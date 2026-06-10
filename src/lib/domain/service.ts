/**
 * Phase 7 — Domain services.
 *
 * The orchestration layer the API talks to. It delegates persistence + access
 * control to the query engine (Phase 5/6), then layers domain concerns on top:
 * lifecycle state transitions, business invariants, audit logging and domain
 * event emission through the transactional outbox (Phase 8).
 */
import { newId } from "@/lib/core/ids";
import { BadRequestError, ConflictError, assertAllowed } from "@/lib/enforcement";
import { scopeOf } from "@/lib/context/isolation";
import type { RequestContext } from "@/lib/context/types";
import type { MetadataResolver } from "@/lib/metadata/resolver";
import type { EntityRecord, FieldValue } from "@/lib/metadata/types";
import type { PermissionEngine } from "@/lib/permissions/engine";
import { numberSequence } from "@/lib/finance/number-sequence";
import type { QueryEngine } from "@/lib/data/query-engine";
import type { AggregateQuery, AggregateRow, Query, Page } from "@/lib/data/query";
import { type DomainEvent, type EventBus } from "@/lib/workflow/event-bus";
import { IdempotencyStore } from "@/lib/workflow/idempotency";
import { Outbox } from "@/lib/workflow/outbox";
import { AuditLog } from "./audit";
import { StateMachine } from "./state-machine";
import { runGuards } from "./invariants";

export interface TransitionOption {
  action: string;
  to: string;
}

export class DomainService {
  constructor(
    private readonly qe: QueryEngine,
    private readonly metadata: MetadataResolver,
    private readonly permissions: PermissionEngine,
    private readonly bus: EventBus,
    private readonly idempotency: IdempotencyStore,
    private readonly audit: AuditLog,
  ) {}

  list(ctx: RequestContext, entity: string, query?: Query): Promise<Page> {
    return this.qe.list(ctx, entity, query);
  }

  get(ctx: RequestContext, entity: string, id: string): Promise<EntityRecord> {
    return this.qe.get(ctx, entity, id);
  }

  aggregate(ctx: RequestContext, entity: string, query: AggregateQuery): Promise<AggregateRow[]> {
    return this.qe.aggregate(ctx, entity, query);
  }

  /**
   * Documents created through the generic `/entities` endpoint that need a
   * human-readable, sequential number. Service-created documents (invoice, quote,
   * PO, …) number themselves; these bespoke-screen entities go through the
   * generic create path where the `number` field is read-only and would
   * otherwise be left blank.
   */
  private static readonly NUMBER_PREFIXES: Record<string, string> = {
    stockTransfer: "TRF",
    stockAdjustment: "ADJ",
  };

  async create(ctx: RequestContext, entity: string, input: unknown): Promise<EntityRecord> {
    const computed = await this.autoNumber(ctx, entity, input);
    const record = computed
      ? await this.qe.createWithComputed(ctx, entity, input, computed)
      : await this.qe.create(ctx, entity, input);
    this.audit.append(ctx, {
      entity,
      recordId: record.id,
      action: "create",
      summary: `created ${entity}`,
    });
    await this.dispatch(this.event(ctx, `${entity}.created`, { id: record.id, record }));
    return record;
  }

  /** Assign a sequential document number for bespoke entities that need one and
   *  weren't given one by the caller (the field is read-only in the create form). */
  private async autoNumber(
    ctx: RequestContext,
    entity: string,
    input: unknown,
  ): Promise<Record<string, FieldValue> | null> {
    const prefix = DomainService.NUMBER_PREFIXES[entity];
    if (!prefix) return null;
    const provided = input && typeof input === "object" ? (input as Record<string, unknown>).number : undefined;
    if (provided) return null;
    return { number: await numberSequence.next(ctx.tenantId, prefix) };
  }

  async update(
    ctx: RequestContext,
    entity: string,
    id: string,
    patch: unknown,
    expectedVersion?: number,
  ): Promise<EntityRecord> {
    const record = await this.qe.update(ctx, entity, id, patch, { expectedVersion });
    this.audit.append(ctx, {
      entity,
      recordId: id,
      action: "update",
      summary: `updated ${entity}`,
    });
    await this.dispatch(this.event(ctx, `${entity}.updated`, { id, record }));
    return record;
  }

  async remove(ctx: RequestContext, entity: string, id: string, expectedVersion?: number): Promise<void> {
    await this.qe.remove(ctx, entity, id, expectedVersion);
    this.audit.append(ctx, {
      entity,
      recordId: id,
      action: "delete",
      summary: `deleted ${entity}`,
    });
    await this.dispatch(this.event(ctx, `${entity}.deleted`, { id }));
  }

  /** Bulk-update many records with one patch (single round-trip). Returns the count changed. */
  async updateMany(ctx: RequestContext, entity: string, ids: string[], patch: unknown): Promise<number> {
    const changed = await this.qe.updateMany(ctx, entity, ids, patch);
    if (changed > 0) {
      this.audit.append(ctx, { entity, recordId: ids[0] ?? "*", action: "update", summary: `bulk updated ${changed} ${entity}` });
    }
    return changed;
  }

  /** Bulk-delete many records by id (single round-trip). Returns the count deleted. */
  async removeMany(ctx: RequestContext, entity: string, ids: string[]): Promise<number> {
    const removed = await this.qe.removeMany(ctx, entity, ids);
    if (removed > 0) {
      this.audit.append(ctx, { entity, recordId: ids[0] ?? "*", action: "delete", summary: `bulk deleted ${removed} ${entity}` });
    }
    return removed;
  }

  /** Run a lifecycle transition by action name. */
  async transition(
    ctx: RequestContext,
    entity: string,
    id: string,
    action: string,
    expectedVersion?: number,
  ): Promise<EntityRecord> {
    const def = this.metadata.getEntity(entity);
    if (!def.lifecycle) throw new BadRequestError(`${def.label} has no lifecycle`);

    const current = await this.qe.get(ctx, entity, id);
    const sm = new StateMachine(def.lifecycle);
    const from = String(current[def.lifecycle.field]);

    const transition = sm.find(from, action);
    if (!transition) {
      throw new ConflictError(`cannot "${action}" a ${def.label} in state "${from}"`);
    }

    if (transition.requires) {
      assertAllowed(
        this.permissions.evaluate(ctx, {
          action: transition.requires,
          entity,
          recordOwnerId: current.ownerId,
        }),
      );
    }

    const failures = runGuards(transition.guards, current);
    if (failures.length) {
      throw new ConflictError(
        `transition blocked: ${failures.join("; ")}`,
        failures.map((m) => ({ message: m })),
      );
    }

    const updated = await this.qe.update(
      ctx,
      entity,
      id,
      { [def.lifecycle.field]: transition.to },
      { allowLifecycleField: true, expectedVersion },
    );

    this.audit.append(ctx, {
      entity,
      recordId: id,
      action: "transition",
      from,
      to: transition.to,
      summary: `${action}: ${from} → ${transition.to}`,
    });

    const outbox = new Outbox(this.bus, this.idempotency);
    outbox.enqueue(this.event(ctx, `${entity}.${action}`, { id, from, to: transition.to, record: updated }));
    outbox.enqueue(this.event(ctx, `${entity}.stage_changed`, { id, from, to: transition.to }));
    await outbox.drain();

    return updated;
  }

  /** Lifecycle actions available to the caller for a record's current state. */
  async availableActions(ctx: RequestContext, entity: string, id: string): Promise<TransitionOption[]> {
    const def = this.metadata.getEntity(entity);
    if (!def.lifecycle) return [];
    const current = await this.qe.get(ctx, entity, id);
    const sm = new StateMachine(def.lifecycle);
    const from = String(current[def.lifecycle.field]);
    return sm
      .transitionsFrom(from)
      .filter(
        (t) =>
          !t.requires ||
          this.permissions.can(ctx, { action: t.requires, entity, recordOwnerId: current.ownerId }),
      )
      .map((t) => ({ action: t.action, to: t.to }));
  }

  // ---- helpers -----------------------------------------------------------

  private event(ctx: RequestContext, type: string, payload: Record<string, unknown>): DomainEvent {
    return {
      id: newId("evt"),
      type,
      at: ctx.at,
      tenantId: ctx.tenantId,
      orgId: ctx.orgId,
      actorId: ctx.userId,
      correlationId: ctx.correlationId,
      payload,
    };
  }

  private async dispatch(event: DomainEvent): Promise<void> {
    const outbox = new Outbox(this.bus, this.idempotency);
    outbox.enqueue(event);
    await outbox.drain();
  }

  auditTrail(ctx: RequestContext, entity: string, id: string) {
    return this.audit.query(scopeOf(ctx), { entity, recordId: id });
  }

  /** Tenant-wide recent audit activity (for the dashboard feed). */
  recentActivity(ctx: RequestContext, limit = 12) {
    return this.audit.query(scopeOf(ctx)).slice(0, limit);
  }
}
