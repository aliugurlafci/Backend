/**
 * The search index, held in the database.
 *
 * Chosen whenever the platform runs on SQL, which is every real deployment. It
 * exists because the in-memory index is per-process, and the index is maintained
 * from an in-process event bus: with two instances, a record written through one
 * was never re-indexed on the other, so search answered differently depending on
 * which instance the load balancer picked, indefinitely.
 *
 * No new query machinery. The repository already compiles a `search` term into
 * an OR of LIKE clauses over an entity's `searchable` fields, and tenant scoping
 * is what every entity read does anyway — so the durable index is an ordinary
 * entity and everything that already guards entity reads guards it too.
 *
 * Matching is `LIKE %term%`, which cannot use a b-tree index and therefore scans
 * the index table. That is the honest trade for portability: MySQL FULLTEXT and
 * SQL Server Full-Text are different enough to need two implementations, and
 * SQL Server's is an optional server feature — DDL for it would fail to install
 * on a server that does not have it, and this codebase's migration is
 * self-healing on boot, so a failing index would mean a server that will not
 * start. One table of a few tens of thousands of rows scans in milliseconds; the
 * day it does not, the fix is a dialect-specific index behind a capability
 * check, not a rewrite of this file.
 */
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import { INTERNAL_MAX_PAGE_SIZE } from "@/lib/data/query";
import { scoreDoc, type SearchDocument, type SearchEngine, type SearchHit, type SearchOptions } from "./engine";

const ENTITY = "searchDocument";

/**
 * How many matching rows are ranked.
 *
 * The database returns the rows that contain the term; the ordering is decided
 * here, so a term common enough to match everything would otherwise pull the
 * whole index into memory to sort it. Capped well above any page a caller sees,
 * so ranking still chooses from a wide field.
 */
const RANK_POOL = 500;

const keyOf = (entity: string, id: string): string => `${entity}:${id}`;

export class SqlSearchEngine implements SearchEngine {
  async index(ctx: RequestContext, doc: SearchDocument): Promise<void> {
    const qe = await getQueryEngine();
    const docKey = keyOf(doc.entity, doc.id);
    const existing = await qe.list(ctx, ENTITY, {
      filters: [{ field: "docKey", op: "eq", value: docKey }],
      pageSize: 1,
    });
    const row = {
      docKey,
      entityName: doc.entity,
      recordId: String(doc.id),
      title: doc.title.slice(0, 400),
      body: doc.text,
      indexedAt: ctx.at,
    };
    const found = existing.items[0];
    if (found) {
      await qe.patchComputed(ctx, ENTITY, String(found.id), row);
      return;
    }
    try {
      await qe.createWithComputed(ctx, ENTITY, row, {});
    } catch {
      // Lost the race with another writer indexing the same record. The unique
      // index on docKey is what makes that a conflict rather than a duplicate
      // row, and the winner wrote the same content — so there is nothing to
      // repair and nothing worth logging.
    }
  }

  async remove(ctx: RequestContext, entity: string, id: string): Promise<void> {
    const qe = await getQueryEngine();
    const existing = await qe.list(ctx, ENTITY, {
      filters: [{ field: "docKey", op: "eq", value: keyOf(entity, id) }],
      pageSize: 1,
    });
    const row = existing.items[0];
    if (row) await qe.remove(ctx, ENTITY, String(row.id));
  }

  async clear(ctx: RequestContext): Promise<void> {
    const qe = await getQueryEngine();
    // Paged, and re-reading the first page each time rather than walking
    // forward: the rows are being deleted underneath, so advancing the offset
    // would step over the ones that shift back.
    for (;;) {
      const page = await qe.list(ctx, ENTITY, { pageSize: INTERNAL_MAX_PAGE_SIZE }, { maxPageSize: INTERNAL_MAX_PAGE_SIZE });
      if (!page.items.length) return;
      for (const row of page.items) await qe.remove(ctx, ENTITY, String(row.id));
    }
  }

  async size(ctx: RequestContext): Promise<number> {
    const qe = await getQueryEngine();
    return (await qe.list(ctx, ENTITY, { pageSize: 1 })).total;
  }

  async search(ctx: RequestContext, term: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const needle = term.trim().toLowerCase();
    if (!needle) return [];
    const qe = await getQueryEngine();

    const page = await qe.list(
      ctx,
      ENTITY,
      {
        search: term.trim(),
        ...(opts.entities?.length ? { filters: [{ field: "entityName", op: "in" as const, value: opts.entities }] } : {}),
        pageSize: RANK_POOL,
      },
      { maxPageSize: INTERNAL_MAX_PAGE_SIZE },
    );

    return page.items
      .map((row) => ({
        entity: String(row.entityName),
        id: String(row.recordId),
        title: String(row.title ?? row.recordId),
        // The same scoring the in-memory engine uses, so switching persistence
        // changes where the hits come from and not what order they arrive in.
        score: scoreDoc({ title: String(row.title ?? ""), text: String(row.body ?? "") }, needle),
      }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, opts.limit ?? 20);
  }
}
