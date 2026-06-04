/**
 * Phase 8 — concrete workflows wired to domain events.
 *
 * Subscribers translate domain events into side effects. They act as the
 * `system` principal via the query engine directly (not the domain service) to
 * avoid re-emitting domain events and to keep the dependency graph acyclic.
 */
import { systemContext } from "@/lib/context/resolver";
import { getQueryEngine } from "@/lib/data/store";
import { logger } from "@/lib/observability/logger";
import { eventBus, type DomainEvent } from "./event-bus";
import { WorkflowEngine } from "./engine";

let registered = false;

export function registerWorkflows(): void {
  if (registered) return;
  registered = true;

  // When a deal is won, kick off an onboarding follow-up task automatically.
  eventBus.subscribe("deal.win", async (event: DomainEvent) => {
    const dealId = String(event.payload.id ?? "");
    const engine = new WorkflowEngine("deal-won", event.id);
    await engine.run([
      {
        name: "create-onboarding-task",
        run: async () => {
          const qe = await getQueryEngine();
          const ctx = systemContext(event.tenantId, event.orgId, {
            correlationId: event.correlationId,
          });
          await qe.create(ctx, "task", {
            subject: "Kick off onboarding for won deal",
            status: "open",
            notes: `Auto-created when deal ${dealId} was won.`,
            dealId,
          });
        },
      },
      {
        name: "notify-team",
        run: async () => {
          logger.info("deal won — notifying account team", {
            dealId,
            correlationId: event.correlationId,
          });
        },
      },
    ]);
  });

  logger.info("workflows registered", { count: 1 });
}
