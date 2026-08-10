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

/**
 * Reporting-line counts, derived by grouping the whole employee and user tables.
 *
 * Cached because it is recomputed on every read of a department — including a
 * single `get` — and the answer only moves when someone's manager changes.
 */
export function headcountsKey(tenantId: string, orgId: string): string {
  return `headcounts:${tenantId}:${orgId}`;
}

let registered = false;

export function registerCacheInvalidation(): void {
  if (registered) return;
  registered = true;

  eventBus.subscribe("*", async (event: DomainEvent) => {
    await cache.invalidatePrefix(`stats:${event.tenantId}:`);
    // Headcounts follow only the two tables they are derived from, so they
    // survive unrelated traffic instead of being thrown away on every write.
    const entity = event.type.split(".")[0];
    if (entity === "employee" || entity === "user") {
      await cache.invalidatePrefix(`headcounts:${event.tenantId}:`);
    }
    // Prices are cached per document line, so a corrected price would otherwise
    // keep being charged for the length of the TTL — which is exactly the window
    // someone would notice and not be able to explain.
    if (entity === "priceList" || entity === "priceListItem" || entity === "account") {
      await cache.invalidatePrefix(`pricing:lists:${event.tenantId}:`);
      await cache.invalidatePrefix(`pricing:rules:${event.tenantId}:`);
    }
    logger.debug("cache invalidated", { tenantId: event.tenantId, trigger: event.type });
  });
}
