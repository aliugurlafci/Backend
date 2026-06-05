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

/** Register subscribers and rebuild the search index from the repository. */
export async function bootstrapPlatform(): Promise<void> {
  ensurePlatform();
  await reindexAll();
  // Seed demo automations once (idempotent — only when the demo tenant is empty).
  try {
    await seedAutomations();
  } catch (error) {
    // Non-fatal: the console still works, just without seeded demo content.
    // (Logged by the store/query layer.)
    void error;
  }
}
