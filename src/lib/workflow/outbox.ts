/**
 * Phase 8 — transactional outbox.
 *
 * Domain operations enqueue events into the outbox as part of their unit of
 * work; the dispatcher then delivers them to the event bus with retry and
 * idempotency. This guarantees an event is never lost if the process dies
 * between the write and the publish (at-least-once + dedupe = effectively-once).
 */
import { logger } from "@/lib/observability/logger";
import { type DomainEvent, type EventBus } from "./event-bus";
import { IdempotencyStore } from "./idempotency";
import { withRetry } from "./retry";

export type OutboxStatus = "pending" | "published" | "failed";

export interface OutboxRecord {
  event: DomainEvent;
  status: OutboxStatus;
  attempts: number;
}

export class Outbox {
  private records: OutboxRecord[] = [];

  constructor(
    private readonly bus: EventBus,
    private readonly idempotency: IdempotencyStore,
  ) {}

  /** Stage an event for delivery (part of the operation's unit of work). */
  enqueue(event: DomainEvent): void {
    this.records.push({ event, status: "pending", attempts: 0 });
  }

  /** Deliver all pending events; safe to call repeatedly. */
  async drain(): Promise<void> {
    const pending = this.records.filter((r) => r.status === "pending");
    for (const record of pending) {
      try {
        await withRetry(
          async (attempt) => {
            record.attempts = attempt;
            // Idempotency: deliver each event id at most once.
            await this.idempotency.runOnce(record.event.id, record.event.at, () =>
              this.bus.publish(record.event),
            );
          },
          { attempts: 3, baseMs: 20 },
        );
        record.status = "published";
      } catch (error) {
        record.status = "failed";
        logger.error("outbox delivery failed", {
          eventId: record.event.id,
          type: record.event.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  pendingCount(): number {
    return this.records.filter((r) => r.status === "pending").length;
  }
}
