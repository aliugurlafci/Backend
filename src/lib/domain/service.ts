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
import { systemContext } from "@/lib/context/resolver";
import type { RequestContext } from "@/lib/context/types";
import type { MetadataResolver } from "@/lib/metadata/resolver";
import type { EntityRecord, FieldValue } from "@/lib/metadata/types";
import type { PermissionEngine } from "@/lib/permissions/engine";
import { numberSequence } from "@/lib/finance/number-sequence";
import { cache } from "@/lib/cache/cache";
import { headcountsKey } from "@/lib/cache/invalidation";
import type { ListOptions, QueryEngine } from "@/lib/data/query-engine";
import type { AggregateQuery, AggregateRow, CursorPage, Query, Page } from "@/lib/data/query";
import { type DomainEvent, type EventBus } from "@/lib/workflow/event-bus";
import { IdempotencyStore } from "@/lib/workflow/idempotency";
import { Outbox } from "@/lib/workflow/outbox";
import { AuditLog, type AuditEntry, type AuditInput } from "./audit";
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
  ) {
    this.outbox = new Outbox(this.bus, this.idempotency);
  }

  /** Durable event staging — one instance, not one per dispatch. */
  private readonly outbox: Outbox;

  async list(
    ctx: RequestContext,
    entity: string,
    query?: Query,
    opts?: ListOptions,
  ): Promise<Page> {
    const page = await this.qe.list(ctx, entity, query, opts);
    if (entity === "department") await this.fillHeadcounts(ctx, page.items);
    return page;
  }

  /** One keyset page — see `QueryEngine.listByCursor`. */
  listByCursor(ctx: RequestContext, entity: string, query?: Query, cursor?: string): Promise<CursorPage> {
    return this.qe.listByCursor(ctx, entity, query, cursor);
  }

  /** Stream every matching record a page at a time — see `QueryEngine.listAll`. */
  listAll(
    ctx: RequestContext,
    entity: string,
    query: Query,
    onPage: (items: EntityRecord[]) => void | Promise<void>,
  ): Promise<number> {
    return this.qe.listAll(ctx, entity, query, onPage);
  }

  /** Read a whole working set, raising rather than truncating — see `QueryEngine.listComplete`. */
  listComplete(ctx: RequestContext, entity: string, query?: Query): Promise<EntityRecord[]> {
    return this.qe.listComplete(ctx, entity, query);
  }

  /** Resolve records by id in driver-safe chunks — see `QueryEngine.listByIds`. */
  listByIds(ctx: RequestContext, entity: string, ids: string[]): Promise<EntityRecord[]> {
    return this.qe.listByIds(ctx, entity, ids);
  }

  async get(ctx: RequestContext, entity: string, id: string): Promise<EntityRecord> {
    const record = await this.qe.get(ctx, entity, id);
    if (entity === "department") await this.fillHeadcounts(ctx, [record]);
    return record;
  }

  /**
   * Live-derive each department's `headcount` = how many people report to its
   * manager (`head`, stored as "employee:<id>" / "user:<id>"). Counts BOTH
   * employees whose `managerRef` is that person AND users whose supervisor
   * (`managerId`) is that user — so the number is always current when the page is
   * opened, without the field ever being entered by hand. Best-effort: on any
   * read failure the stored value is left untouched.
   */
  private async fillHeadcounts(ctx: RequestContext, departments: EntityRecord[]): Promise<void> {
    if (departments.length === 0) return;
    // Nothing to look up if no department in this batch names a head — which is
    // the common case on a fresh tenant, and free to check.
    if (!departments.some((d) => d.head)) {
      for (const d of departments) d.headcount = 0;
      return;
    }
    const sys = systemContext(ctx.tenantId, ctx.orgId);
    try {
      // Two grouped counts over the whole employee and user tables. They are
      // exact (a paged list would silently cap at MAX_PAGE_SIZE and undercount)
      // but they ran on every department read, including a single `get` — so the
      // result is cached and invalidated by employee/user events rather than
      // recomputed per request.
      const reportsByManager = await cache.wrap(
        headcountsKey(ctx.tenantId, ctx.orgId),
        60_000,
        async () => {
          const [empRows, userRows] = await Promise.all([
            this.qe.aggregate(sys, "employee", { groupBy: "managerRef", measures: [{ op: "count", as: "c" }] }),
            this.qe.aggregate(sys, "user", { groupBy: "managerId", measures: [{ op: "count", as: "c" }] }),
          ]);
          // One map keyed by the person ref a report points at. Employees group by
          // `managerRef` ("employee:.." | "user:..") and users by "user:<managerId>",
          // so a manager's combined report count is a single lookup.
          const counts: Record<string, number> = {};
          for (const r of empRows) {
            const key = r.key != null ? String(r.key).trim() : "";
            if (key) counts[key] = (counts[key] ?? 0) + (r.measures.c ?? 0);
          }
          for (const r of userRows) {
            const mid = r.key != null ? String(r.key).trim() : "";
            if (mid) {
              const key = `user:${mid}`;
              counts[key] = (counts[key] ?? 0) + (r.measures.c ?? 0);
            }
          }
          return counts;
        },
      );
      for (const d of departments) {
        const head = d.head ? String(d.head) : "";
        d.headcount = head ? reportsByManager[head] ?? 0 : 0;
      }
    } catch {
      /* counting failed (e.g. unreadable) — leave the stored headcount as-is */
    }
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
    return this.commitAndPublish(ctx, async () => {
      const record = computed
        ? await this.qe.createWithComputed(ctx, entity, input, computed)
        : await this.qe.create(ctx, entity, input);
      return {
        result: record,
        audit: { entity, recordId: record.id, action: "create", summary: `created ${entity}` },
        events: [this.event(ctx, `${entity}.created`, { id: record.id, record })],
      };
    });
  }

  /**
   * Create with server-computed fields (e.g. a user's passwordHash) AND emit the
   * `${entity}.created` domain event — so records made through bespoke routes
   * (admin user creation, etc.) still trigger automations/webhooks, instead of
   * silently bypassing them like a raw query-engine write would.
   */
  async createWithComputed(
    ctx: RequestContext,
    entity: string,
    input: unknown,
    computed: Record<string, FieldValue>,
  ): Promise<EntityRecord> {
    return this.commitAndPublish(ctx, async () => {
      const record = await this.qe.createWithComputed(ctx, entity, input, computed);
      return {
        result: record,
        audit: { entity, recordId: record.id, action: "create", summary: `created ${entity}` },
        events: [this.event(ctx, `${entity}.created`, { id: record.id, record })],
      };
    });
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
    return this.commitAndPublish(ctx, async () => {
      const record = await this.qe.update(ctx, entity, id, patch, { expectedVersion });
      return {
        result: record,
        audit: { entity, recordId: id, action: "update", summary: `updated ${entity}` },
        events: [this.event(ctx, `${entity}.updated`, { id, record })],
      };
    });
  }

  /**
   * Financial records that must not be hard-deleted (it would destroy the audit
   * trail and desync the GL). `always` = never deletable (reverse/void instead);
   * `ifNotDraft` = deletable only while still a draft (once posted, void it).
   */
  private static readonly PROTECTED_DELETE: Record<string, "always" | "ifNotDraft"> = {
    journalEntry: "always",
    journalLine: "always",
    payment: "always",
    billPayment: "always",
    stockMovement: "always",
    invoice: "ifNotDraft",
    vendorBill: "ifNotDraft",
  };

  /** Reject deletes that would erase a posted financial record. */
  private async assertDeletable(ctx: RequestContext, entity: string, id: string): Promise<void> {
    const rule = DomainService.PROTECTED_DELETE[entity];
    if (!rule) return;
    if (rule === "always") {
      throw new ConflictError(`${entity} records cannot be deleted — void or reverse them instead`).withKey("err.protectedDelete", { entity });
    }
    const record = await this.qe.get(ctx, entity, id);
    if (String(record.status) !== "draft") {
      throw new ConflictError(`a ${String(record.status)} ${entity} cannot be deleted — void it instead`).withKey("err.protectedDeleteStatus", { status: String(record.status), entity });
    }
  }

  async remove(ctx: RequestContext, entity: string, id: string, expectedVersion?: number): Promise<void> {
    await this.assertDeletable(ctx, entity, id);
    // Snapshot the row BEFORE deletion so the `deleted` event can carry the full
    // record — otherwise delete-triggered automations could never resolve
    // {{record.*}} (the row is gone by the time they run).
    const record = await this.qe.get(ctx, entity, id).catch(() => undefined);
    await this.commitAndPublish(ctx, async () => {
      await this.qe.remove(ctx, entity, id, expectedVersion);
      return {
        result: undefined,
        audit: { entity, recordId: id, action: "delete", summary: `deleted ${entity}` },
        events: [this.event(ctx, `${entity}.deleted`, record ? { id, record } : { id })],
      };
    });
  }

  /** Bulk-update many records with one patch (single round-trip). Returns the count changed. */
  async updateMany(ctx: RequestContext, entity: string, ids: string[], patch: unknown): Promise<number> {
    const changed = await this.qe.updateMany(ctx, entity, ids, patch);
    if (changed > 0) {
      await this.audit.append(ctx, { entity, recordId: ids[0] ?? "*", action: "update", summary: `bulk updated ${changed} ${entity}` });
    }
    return changed;
  }

  /** Bulk-delete many records by id (single round-trip). Returns the count deleted. */
  async removeMany(ctx: RequestContext, entity: string, ids: string[]): Promise<number> {
    if (DomainService.PROTECTED_DELETE[entity]) {
      throw new ConflictError(`${entity} records cannot be bulk-deleted — void or reverse them instead`).withKey("err.protectedBulkDelete", { entity });
    }
    const removed = await this.qe.removeMany(ctx, entity, ids);
    if (removed > 0) {
      await this.audit.append(ctx, { entity, recordId: ids[0] ?? "*", action: "delete", summary: `bulk deleted ${removed} ${entity}` });
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
    if (!def.lifecycle) throw new BadRequestError(`${def.label} has no lifecycle`).withKey("err.noLifecycle", { entity: def.name });

    const current = await this.qe.get(ctx, entity, id);
    const sm = new StateMachine(def.lifecycle);
    const from = String(current[def.lifecycle.field]);

    const transition = sm.find(from, action);
    if (!transition) {
      throw new ConflictError(`cannot "${action}" a ${def.label} in state "${from}"`).withKey("err.invalidTransition", { action, entity: def.name, state: from });
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
      ).withKey("err.transitionBlocked", { reasons: failures.join("; ") });
    }

    const lifecycleField = def.lifecycle.field;
    return this.commitAndPublish(ctx, async () => {
      const updated = await this.qe.update(
        ctx,
        entity,
        id,
        { [lifecycleField]: transition.to },
        { allowLifecycleField: true, expectedVersion },
      );
      const payload = { id, from, to: transition.to, record: updated };
      return {
        result: updated,
        audit: {
          entity,
          recordId: id,
          action: "transition" as const,
          from,
          to: transition.to,
          summary: `${action}: ${from} → ${transition.to}`,
        },
        // Two events: the specific action (invoice.send) and the generic stage
        // change, so a rule can subscribe to either.
        events: [
          this.event(ctx, `${entity}.${action}`, payload),
          this.event(ctx, `${entity}.stage_changed`, payload),
        ],
      };
    });
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

  /**
   * Perform a write, its audit entry and its domain events as ONE unit of work,
   * then publish after the commit.
   *
   * The staging and the change share a transaction, so an event can never
   * describe something that was rolled back — and a change can never commit
   * without its event being durably queued. Publication happens afterwards: a
   * subscriber run inside the transaction would be acting on data nobody else
   * can see yet, and would have to be undone if the write failed.
   *
   * Delivery failures do not propagate. The write has committed; the event stays
   * `pending` and the outbox recovery job retries it.
   */
  private async commitAndPublish<T>(
    ctx: RequestContext,
    work: () => Promise<{ result: T; audit?: AuditInput; events: DomainEvent[] }>,
  ): Promise<T> {
    const staged = await this.qe.runInTransaction(async () => {
      const out = await work();
      if (out.audit) await this.audit.append(ctx, out.audit);
      for (const event of out.events) await this.outbox.enqueue(event);
      return out;
    });
    for (const event of staged.events) await this.outbox.deliver(event);
    return staged.result;
  }

  private async dispatch(event: DomainEvent): Promise<void> {
    await this.outbox.enqueue(event);
    await this.outbox.deliver(event);
  }

  auditTrail(ctx: RequestContext, entity: string, id: string): Promise<AuditEntry[]> {
    return this.audit.query(ctx, { entity, recordId: id });
  }

  /** Tenant-wide recent audit activity (for the dashboard feed). */
  recentActivity(ctx: RequestContext, limit = 12): Promise<AuditEntry[]> {
    // Narrowed in SQL rather than by slicing a full read — the trail only grows.
    return this.audit.query(ctx, { limit });
  }
}
