/**
 * Phase 11 — indexing strategy.
 *
 * Keeps the search index in sync with data: a full reindex from the repository
 * at startup, then incremental updates driven by domain events (created/updated
 * re-index the record; deleted removes it).
 */
import { metadata } from "@/lib/metadata";
import type { EntityRecord } from "@/lib/metadata/types";
import { ORG_ID, TENANT_ID } from "@/lib/config/env";
import { systemContext } from "@/lib/context/resolver";
import { getQueryEngine } from "@/lib/data/store";
import { eventBus, type DomainEvent } from "@/lib/workflow/event-bus";
import { logger } from "@/lib/observability/logger";
import { type SearchDocument } from "./engine";
import { searchStore } from "./store";

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

/**
 * Rebuild the entire index, a page at a time.
 *
 * This used to call `repository.scanAll()` — an unpaginated `SELECT *` over
 * every table — on the critical boot path, so the whole database was buffered
 * into process memory before the server would accept its first request. That is
 * an out-of-memory failure waiting on data growth, and it made startup time a
 * function of table size.
 *
 * Only entities that declare a `searchable` field are visited: the rest can
 * never contribute a document, so reading them was pure cost.
 *
 * Not transactional. A record written while this runs may be indexed twice or
 * missed; the incremental subscriber below corrects either case on the next
 * write, and a search index is an approximation by nature.
 *
 * `force` distinguishes a repair from a boot. A boot must not rebuild an index
 * that is already populated: now that the index is a shared table, the rebuild
 * CLEARS what every other instance is serving from, so a rolling restart would
 * empty search for every user, one instance at a time, for no benefit. Rebuild
 * on first boot, when there is nothing to lose, and on demand when something is
 * actually wrong.
 */
export async function reindexAll(opts: { force?: boolean } = {}): Promise<void> {
  const qe = await getQueryEngine();
  const ctx = systemContext(TENANT_ID, ORG_ID);
  const entities = metadata.listEntities().filter((e) => e.fields.some((f) => f.searchable));

  const engine = searchStore();
  const existing = await engine.size(ctx);
  if (existing > 0 && !opts.force) {
    logger.info("search index already populated; skipping rebuild", { documents: existing });
    return;
  }
  await engine.clear(ctx);
  let documents = 0;
  for (const entity of entities) {
    try {
      await qe.listAll(ctx, entity.name, {}, async (batch) => {
        for (const record of batch) {
          await engine.index(ctx, buildDocument(entity.name, record));
          documents++;
        }
      });
    } catch (error) {
      // One unreadable entity must not abort the whole index.
      logger.warn("search reindex skipped an entity", {
        entity: entity.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logger.info("search reindex complete", { documents, entities: entities.length });
}

let registered = false;

/** Wire incremental index maintenance to domain events. */
export function registerSearchIndexing(): void {
  if (registered) return;
  registered = true;

  eventBus.subscribe("*", async (event: DomainEvent) => {
    const entity = event.type.split(".")[0] ?? "";
    if (!metadata.findEntity(entity)) return;
    // The index indexing itself: every write below publishes its own event, so
    // without this the first indexed record loops until the stack gives out.
    if (entity === "searchDocument") return;

    const ctx = systemContext(event.tenantId, event.orgId);
    const engine = searchStore();
    try {
      if (event.type.endsWith(".deleted")) {
        await engine.remove(ctx, entity, String(event.payload.id));
        return;
      }
      const record = event.payload.record as EntityRecord | undefined;
      if (record) await engine.index(ctx, buildDocument(entity, record));
    } catch (error) {
      // A failed index update must not fail the write that triggered it. The
      // record is saved either way; search is a convenience over data the
      // database already serves, and the next write to the record repairs it.
      logger.warn("search index update failed", {
        entity,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
