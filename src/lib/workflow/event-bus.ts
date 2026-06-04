/**
 * Phase 8 — event bus abstraction.
 *
 * Decouples producers (domain services) from consumers (workflows, webhooks,
 * search indexers). The in-memory bus dispatches synchronously within the
 * process; the same interface fronts a Redis/broker implementation in prod.
 * Handler failures are isolated and logged — one bad subscriber never breaks
 * publication for the others.
 */
import { logger } from "@/lib/observability/logger";

export interface DomainEvent<P = Record<string, unknown>> {
  id: string;
  type: string;
  at: string;
  tenantId: string;
  orgId: string;
  actorId: string;
  correlationId: string;
  payload: P;
}

export type EventHandler = (event: DomainEvent) => Promise<void> | void;

export interface EventBus {
  subscribe(type: string, handler: EventHandler): () => void;
  publish(event: DomainEvent): Promise<void>;
}

export class InMemoryEventBus implements EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  subscribe(type: string, handler: EventHandler): () => void {
    const set = this.handlers.get(type) ?? new Set<EventHandler>();
    set.add(handler);
    this.handlers.set(type, set);
    return () => set.delete(handler);
  }

  async publish(event: DomainEvent): Promise<void> {
    const targeted = this.handlers.get(event.type) ?? new Set();
    const wildcard = this.handlers.get("*") ?? new Set();
    const all = [...targeted, ...wildcard];

    for (const handler of all) {
      try {
        await handler(event);
      } catch (error) {
        logger.error("event handler failed", {
          type: event.type,
          eventId: event.id,
          correlationId: event.correlationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

export const eventBus = new InMemoryEventBus();
