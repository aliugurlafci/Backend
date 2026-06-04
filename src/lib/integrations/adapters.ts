/**
 * Phase 9 — Integration adapters.
 *
 * A pluggable adapter interface for outbound integrations (CRM sync, email,
 * messaging). Adapters subscribe to domain events; the registry lets the app
 * enable/disable them per deployment. A sample logging adapter is included.
 */
import { eventBus, type DomainEvent } from "@/lib/workflow/event-bus";
import { logger } from "@/lib/observability/logger";

export interface IntegrationAdapter {
  name: string;
  /** Event types this adapter reacts to (`*` for all). */
  events: string[];
  handle(event: DomainEvent): Promise<void>;
}

export class AdapterRegistry {
  private adapters: IntegrationAdapter[] = [];
  private unsubscribers: Array<() => void> = [];

  enable(adapter: IntegrationAdapter): void {
    this.adapters.push(adapter);
    for (const type of adapter.events) {
      this.unsubscribers.push(
        eventBus.subscribe(type, (event) => adapter.handle(event)),
      );
    }
    logger.info("integration adapter enabled", { adapter: adapter.name });
  }

  list(): string[] {
    return this.adapters.map((a) => a.name);
  }
}

export const adapterRegistry = new AdapterRegistry();

/** Example adapter: logs a line whenever a deal is won. */
export const dealWonNotifier: IntegrationAdapter = {
  name: "deal-won-notifier",
  events: ["deal.win"],
  async handle(event) {
    logger.info("[integration] deal won", { dealId: event.payload.id });
  },
};
