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
import type { EntityRecord } from "@/lib/metadata/types";
import type { PermissionEngine } from "@/lib/permissions/engine";
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

  async create(ctx: RequestContext, entity: string, input: unknown): Promise<EntityRecord> {
    const record = await this.qe.create(ctx, entity, input);
    this.audit.append(ctx, {
      entity,
      recordId: record.id,
      action: "create",
      summary: `created ${entity}`,
    });
    await this.dispatch(this.event(ctx, `${entity}.created`, { id: record.id, record }));
    return record;
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

  /** Convert a lead into an Account + Contact + Deal, marking it converted. */
  async convertLead(ctx: RequestContext, leadId: string): Promise<{ accountId: string; contactId: string; dealId: string }> {
    const lead = await this.qe.get(ctx, "lead", leadId);
    assertAllowed(
      this.permissions.evaluate(ctx, { action: "lead:convert", entity: "lead", recordOwnerId: lead.ownerId }),
    );
    if (lead.status === "converted") throw new ConflictError("lead already converted");
    if (!lead.email) throw new BadRequestError("lead needs an email before it can be converted");

    const company = String(lead.company || lead.name);
    const existing = await this.qe.list(ctx, "account", {
      filters: [{ field: "name", op: "eq", value: company }],
      pageSize: 1,
    });
    const accountId = existing.items[0]?.id ?? (await this.create(ctx, "account", { name: company })).id;

    const [firstName, ...rest] = String(lead.name).trim().split(/\s+/);
    const lastName = rest.join(" ") || firstName;
    const contact = await this.create(ctx, "contact", {
      firstName,
      lastName,
      email: lead.email,
      phone: lead.phone ?? null,
      accountId,
    });
    const deal = await this.create(ctx, "deal", {
      name: `${company} Opportunity`,
      stage: "lead",
      amount: lead.estimatedValue ?? null,
      accountId,
    });

    await this.qe.update(ctx, "lead", leadId, { status: "converted" }, { allowLifecycleField: true });
    this.audit.append(ctx, {
      entity: "lead",
      recordId: leadId,
      action: "transition",
      from: String(lead.status),
      to: "converted",
      summary: "converted to account, contact & deal",
    });
    await this.dispatch(this.event(ctx, "lead.converted", { id: leadId, accountId, contactId: contact.id, dealId: deal.id }));

    return { accountId, contactId: contact.id, dealId: deal.id };
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
