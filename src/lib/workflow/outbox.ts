/**
 * Phase 8 — transactional outbox.
 *
 * Domain operations stage events here as part of their unit of work: `enqueue`
 * writes a row inside the caller's transaction, so the event and the change it
 * describes commit or roll back together. `deliver` publishes AFTER that commit
 * and marks the row published.
 *
 * The recovery path is what makes the guarantee real. If the process dies
 * between commit and delivery — or a subscriber keeps failing — the row stays
 * `pending`, and `recoverPending` (run by the scheduler) delivers it later.
 * Combined with the idempotency store's dedupe on event id, that is
 * at-least-once delivery with effectively-once handling.
 *
 * Before this, records lived in a per-call array and were never persisted, so an
 * event was lost outright if the process died between the write and the publish
 * — while this file claimed the opposite. Automations, webhooks and accounting
 * postings all ride on these events.
 */
import { systemContext } from "@/lib/context/resolver";
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import { systemClock } from "@/lib/core/clock";
import { logger } from "@/lib/observability/logger";
import type { EntityRecord } from "@/lib/metadata/types";
import { type DomainEvent, type EventBus } from "./event-bus";
import { IdempotencyStore } from "./idempotency";
import { withRetry } from "./retry";

export type OutboxStatus = "pending" | "published" | "failed";

const ENTITY = "outboxEvent";

/** Give up on a row after this many delivery attempts; it stays visible as `failed`. */
const MAX_ATTEMPTS = 5;

function sys(ctx: { tenantId: string; orgId: string }): RequestContext {
  return systemContext(ctx.tenantId, ctx.orgId);
}

/** Storage row → the event shape subscribers receive. */
function toEvent(row: EntityRecord): DomainEvent {
  let payload: Record<string, unknown> = {};
  try {
    payload = row.payload ? (JSON.parse(String(row.payload)) as Record<string, unknown>) : {};
  } catch {
    // A row we cannot parse must not stall the queue; deliver it with an empty
    // payload so subscribers that only need the type still run, and log it.
    logger.warn("outbox payload could not be parsed", { eventId: String(row.eventId), type: String(row.type) });
  }
  return {
    id: String(row.eventId),
    type: String(row.type),
    at: String(row.at),
    tenantId: String(row.tenantId),
    orgId: String(row.orgId),
    actorId: String(row.actorId ?? ""),
    correlationId: String(row.correlationId ?? ""),
    payload,
  };
}

export class Outbox {
  constructor(
    private readonly bus: EventBus,
    private readonly idempotency: IdempotencyStore,
  ) {}

  /**
   * Stage an event.
   *
   * Call this INSIDE the transaction that performs the change. The driver's
   * transactions join by async context, so the insert lands in the caller's
   * unit of work automatically — no plumbing required, but also no atomicity if
   * you call it outside one.
   */
  async enqueue(event: DomainEvent): Promise<void> {
    const qe = await getQueryEngine();
    await qe.create(sys(event), ENTITY, {
      eventId: event.id,
      type: event.type,
      at: event.at,
      actorId: event.actorId,
      correlationId: event.correlationId,
      payload: JSON.stringify(event.payload ?? {}),
      status: "pending",
      attempts: 0,
    });
  }

  /**
   * Publish a staged event and mark it delivered.
   *
   * Call AFTER the enqueueing transaction has committed — publishing inside it
   * would run subscribers against data no one else can see yet, and a rollback
   * would leave them acting on a change that never happened.
   *
   * Never throws: a delivery failure leaves the row `pending` for the recovery
   * job rather than failing the operation that produced it. The write already
   * committed; refusing to return it because a webhook was slow helps no one.
   */
  async deliver(event: DomainEvent): Promise<void> {
    const ctx = sys(event);
    try {
      await withRetry(
        async () => {
          // Dedupe on event id, so a redelivery after a partial failure does not
          // run subscribers twice.
          await this.idempotency.runOnce(event.id, event.at, () => this.bus.publish(event));
        },
        { attempts: 3, baseMs: 20 },
      );
      await this.markPublished(ctx, event.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.markAttempt(ctx, event.id, message);
      logger.error("outbox delivery failed; left pending for recovery", {
        eventId: event.id,
        type: event.type,
        error: message,
      });
    }
  }

  /**
   * Deliver events that were staged but never published — the crash-recovery
   * path. Run by the scheduler; safe to run concurrently with live traffic
   * because delivery is deduped on event id.
   */
  async recoverPending(ctx: RequestContext, limit = 100): Promise<{ delivered: number; failed: number }> {
    const qe = await getQueryEngine();
    const page = await qe.list(
      sys(ctx),
      ENTITY,
      {
        filters: [{ field: "status", op: "eq", value: "pending" }],
        sort: [{ field: "at", dir: "asc" }], // oldest first
        pageSize: limit,
      },
      { maxPageSize: limit },
    );

    let delivered = 0;
    let failed = 0;
    for (const row of page.items) {
      if (Number(row.attempts ?? 0) >= MAX_ATTEMPTS) {
        await this.markFailed(sys(ctx), String(row.eventId));
        failed++;
        continue;
      }
      await this.deliver(toEvent(row));
      // `deliver` swallows failures, so re-read the outcome rather than assume it.
      const after = await this.findByEventId(sys(ctx), String(row.eventId));
      if (after?.status === "published") delivered++;
      else failed++;
    }
    return { delivered, failed };
  }

  /** Pending rows awaiting delivery — for the health/metrics view. */
  async pendingCount(ctx: RequestContext): Promise<number> {
    const qe = await getQueryEngine();
    const rows = await qe.aggregate(sys(ctx), ENTITY, {
      filters: [{ field: "status", op: "eq", value: "pending" }],
      measures: [{ op: "count", as: "n" }],
    });
    return rows[0]?.measures.n ?? 0;
  }

  private async findByEventId(ctx: RequestContext, eventId: string): Promise<EntityRecord | undefined> {
    const qe = await getQueryEngine();
    const page = await qe.list(ctx, ENTITY, {
      filters: [{ field: "eventId", op: "eq", value: eventId }],
      pageSize: 1,
    });
    return page.items[0];
  }

  private async markPublished(ctx: RequestContext, eventId: string): Promise<void> {
    const row = await this.findByEventId(ctx, eventId);
    if (!row) return;
    const qe = await getQueryEngine();
    await qe.patchComputed(ctx, ENTITY, row.id, {
      status: "published",
      publishedAt: systemClock.isoNow(),
    });
  }

  private async markAttempt(ctx: RequestContext, eventId: string, error: string): Promise<void> {
    const row = await this.findByEventId(ctx, eventId);
    if (!row) return;
    const qe = await getQueryEngine();
    await qe.patchComputed(ctx, ENTITY, row.id, {
      attempts: Number(row.attempts ?? 0) + 1,
      lastError: error.slice(0, 2000),
    });
  }

  private async markFailed(ctx: RequestContext, eventId: string): Promise<void> {
    const row = await this.findByEventId(ctx, eventId);
    if (!row) return;
    const qe = await getQueryEngine();
    await qe.patchComputed(ctx, ENTITY, row.id, { status: "failed" });
    logger.error("outbox event exhausted its retries", {
      eventId,
      type: String(row.type),
      attempts: Number(row.attempts ?? 0),
    });
  }
}
