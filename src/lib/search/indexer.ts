/**
 * Phase 11 — indexing strategy.
 *
 * Keeps the search index in sync with data: a full reindex from the repository
 * at startup, then incremental updates driven by domain events (created/updated
 * re-index the record; deleted removes it).
 */
import { metadata } from "@/lib/metadata";
import type { EntityRecord } from "@/lib/metadata/types";
import { getRepository } from "@/lib/data/store";
import { eventBus, type DomainEvent } from "@/lib/workflow/event-bus";
import { logger } from "@/lib/observability/logger";
import { searchEngine, type SearchDocument } from "./engine";

export function buildDocument(entityName: string, record: EntityRecord): SearchDocument {
  const entity = metadata.getEntity(entityName);
  const title = String(record[entity.titleField] ?? record.id);
  const text = entity.fields
    .filter((f) => f.searchable)
    .map((f) => record[f.name])
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  return {
    entity: entityName,
    id: record.id,
    tenantId: record.tenantId,
    orgId: record.orgId,
    title,
    text,
  };
}

/** Rebuild the entire index from the repository. */
export async function reindexAll(): Promise<void> {
  searchEngine.clear();
  for (const { entity, record } of await getRepository().scanAll()) {
    searchEngine.index(buildDocument(entity, record));
  }
  logger.info("search reindex complete", { documents: searchEngine.size() });
}

let registered = false;

/** Wire incremental index maintenance to domain events. */
export function registerSearchIndexing(): void {
  if (registered) return;
  registered = true;

  eventBus.subscribe("*", async (event: DomainEvent) => {
    const entity = event.type.split(".")[0];
    if (!metadata.findEntity(entity)) return;

    if (event.type.endsWith(".deleted")) {
      searchEngine.remove(entity, String(event.payload.id));
      return;
    }
    const record = event.payload.record as EntityRecord | undefined;
    if (record) searchEngine.index(buildDocument(entity, record));
  });
}
