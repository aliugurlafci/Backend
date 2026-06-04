/**
 * Phase 11 — cache invalidation rules.
 *
 * Tenant-scoped derived caches (e.g. dashboard stats) are invalidated whenever
 * a record in that tenant changes, keeping reads fresh without per-write cache
 * bookkeeping at every call site.
 */
import { eventBus, type DomainEvent } from "@/lib/workflow/event-bus";
import { logger } from "@/lib/observability/logger";
import { cache } from "./cache";

export function statsKey(tenantId: string, orgId: string): string {
  return `stats:${tenantId}:${orgId}`;
}

let registered = false;

export function registerCacheInvalidation(): void {
  if (registered) return;
  registered = true;

  eventBus.subscribe("*", async (event: DomainEvent) => {
    await cache.invalidatePrefix(`stats:${event.tenantId}:`);
    logger.debug("cache invalidated", { tenantId: event.tenantId, trigger: event.type });
  });
}
