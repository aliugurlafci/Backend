/**
 * Platform bootstrap — wires the cross-cutting event subscribers once.
 *
 * `ensurePlatform()` registers subscribers synchronously (idempotent) so events
 * are handled from the first request. `bootstrapPlatform()` additionally runs a
 * full search reindex from the repository — call it once at startup after the
 * store is connected & seeded.
 */
import { registerWorkflows } from "@/lib/workflow/workflows";
import { registerSearchIndexing, reindexAll } from "@/lib/search/indexer";
import { registerCacheInvalidation } from "@/lib/cache/invalidation";
import { registerWebhookDelivery } from "@/lib/integrations/webhooks";
import { registerNotifications } from "@/lib/integrations/notifications";
import { registerAutomationEngine, seedAutomations } from "@/lib/automation";
import { registerAccountingPostings } from "@/lib/accounting/postings";
import { seedFeatureFlags } from "@/lib/config/feature-flags";
import { eventBus, type DomainEvent } from "@/lib/workflow/event-bus";
import { deleteBlob } from "@/lib/integrations/file-storage";
import { logger } from "@/lib/observability/logger";
import { loadRevocations } from "@/lib/security/revocation";

let booted = false;

/** Remove a file's bytes from storage when its record is deleted. */
function registerFileCleanup(): void {
  eventBus.subscribe("*", async (event: DomainEvent) => {
    if (event.type === "file.deleted") await deleteBlob(String(event.payload.id));
  });
}

export function ensurePlatform(): void {
  if (booted) return;
  booted = true;
  seedFeatureFlags();
  registerWorkflows();
  registerSearchIndexing();
  registerCacheInvalidation();
  registerWebhookDelivery();
  registerNotifications();
  registerAutomationEngine();
  registerAccountingPostings();
  registerFileCleanup();
}

/**
 * Register subscribers, then start the search reindex in the background.
 *
 * The reindex is deliberately NOT awaited. Search is a convenience over data the
 * database already serves, so blocking the listener on it made startup time a
 * function of table size and turned a slow index into an outage. Subscribers are
 * registered first, so any record written while the rebuild runs is still
 * indexed incrementally.
 *
 * Until it finishes, `/search` returns fewer results — never wrong ones.
 */
export async function bootstrapPlatform(): Promise<void> {
  ensurePlatform();

  // Custom fields, before anything reads the data model.
  //
  // Awaited and ordered first: the model has to include them before the search
  // indexer, the automation engine or the first request looks at an entity. A
  // field that appears half a second late is a column the API says does not
  // exist.
  try {
    const { applyCustomFields } = await import("@/lib/metadata/custom-fields");
    const { systemContext } = await import("@/lib/context/resolver");
    const { TENANT_ID, ORG_ID } = await import("@/lib/config/env");
    await applyCustomFields(systemContext(TENANT_ID, ORG_ID));
  } catch (error) {
    // Non-fatal. A system that will not start because a customisation could not
    // be applied is worse than one that starts with the built-in model — and the
    // built-in model is what every existing record already conforms to.
    logger.warn("custom fields could not be applied; continuing with the built-in model", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Awaited, unlike the search reindex below. An empty denylist means every
  // revoked token is accepted again, so serving requests before it is loaded
  // would make a restart a way to undo a sign-out.
  await loadRevocations();

  void reindexAll().catch((error) => {
    logger.warn("search reindex failed; search will fill in from live writes", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // Seed demo automations once (idempotent — only when the demo tenant is empty).
  try {
    await seedAutomations();
  } catch (error) {
    // Non-fatal: the console still works, just without seeded demo content.
    // (Logged by the store/query layer.)
    void error;
  }
}
