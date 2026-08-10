/**
 * Phase 11 — search engine abstraction + in-memory index.
 *
 * A maintained document index (separate from the source of truth) kept fresh by
 * the event-driven indexer. The same interface fronts the durable SQL index
 * (`sql-engine.ts`) and would front an external engine (OpenSearch/Typesense).
 *
 * This implementation is chosen when the platform runs without SQL — the same
 * split as `memory-repository.ts` against `sql/repository.ts`, decided by the
 * same `AULA_PERSISTENCE` flag. It is the right index for a single process and
 * the wrong one for two, because it is maintained from the in-process event bus:
 * see the note on the `searchDocument` entity for what that costs.
 */
import type { TenantScope } from "@/lib/context/types";
import type { RequestContext } from "@/lib/context/types";

export interface SearchDocument {
  entity: string;
  id: string;
  tenantId: string;
  orgId: string;
  title: string;
  text: string;
}

export interface SearchHit {
  entity: string;
  id: string;
  title: string;
  score: number;
}

export interface SearchOptions {
  entities?: string[];
  limit?: number;
}

/**
 * How well a document answers the term.
 *
 * Exported so the SQL engine ranks identically. The database decides WHICH rows
 * match; ranking stays here, in one place, because two engines that order the
 * same hits differently is a difference users notice and nobody can explain.
 */
export function scoreDoc(doc: Pick<SearchDocument, "title" | "text">, needle: string): number {
  const title = doc.title.toLowerCase();
  const text = doc.text.toLowerCase();
  let score = 0;
  if (title.includes(needle)) score += 3;
  if (title.startsWith(needle)) score += 2;
  if (text.includes(needle)) score += 1;
  return score;
}

/**
 * What every index must do.
 *
 * Async throughout, because a durable index is a round trip. The in-memory
 * implementation returns resolved promises rather than the interface being
 * sync-or-async, so a caller cannot accidentally depend on one of them being
 * immediate.
 */
export interface SearchEngine {
  index(ctx: RequestContext, doc: SearchDocument): Promise<void>;
  remove(ctx: RequestContext, entity: string, id: string): Promise<void>;
  /** Drop everything for the caller's tenant, ahead of a full rebuild. */
  clear(ctx: RequestContext): Promise<void>;
  search(ctx: RequestContext, term: string, opts?: SearchOptions): Promise<SearchHit[]>;
  size(ctx: RequestContext): Promise<number>;
}

export class InMemorySearchEngine implements SearchEngine {
  private docs = new Map<string, SearchDocument>();

  private key(entity: string, id: string): string {
    return `${entity}:${id}`;
  }

  async index(_ctx: RequestContext, doc: SearchDocument): Promise<void> {
    this.docs.set(this.key(doc.entity, doc.id), doc);
  }

  async remove(_ctx: RequestContext, entity: string, id: string): Promise<void> {
    this.docs.delete(this.key(entity, id));
  }

  async clear(ctx: RequestContext): Promise<void> {
    // Tenant-scoped, matching the SQL engine. Wiping the whole map would be
    // correct for this deployment and wrong the moment there are two tenants —
    // and a reindex of one would silently empty the other's index.
    for (const [key, doc] of this.docs) {
      if (doc.tenantId === ctx.tenantId && doc.orgId === ctx.orgId) this.docs.delete(key);
    }
  }

  async size(_ctx: RequestContext): Promise<number> {
    return this.docs.size;
  }

  async search(ctx: RequestContext, term: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    return this.searchSync(ctx, term, opts);
  }

  /** The matching itself, kept sync so the tests can read it without awaiting. */
  searchSync(scope: TenantScope, term: string, opts: SearchOptions = {}): SearchHit[] {
    const needle = term.trim().toLowerCase();
    if (!needle) return [];
    const hits: SearchHit[] = [];
    for (const doc of this.docs.values()) {
      if (doc.tenantId !== scope.tenantId || doc.orgId !== scope.orgId) continue;
      if (opts.entities && !opts.entities.includes(doc.entity)) continue;
      const score = scoreDoc(doc, needle);
      if (score > 0) hits.push({ entity: doc.entity, id: doc.id, title: doc.title, score });
    }
    // Title breaks a score tie, matching the SQL engine. Without it, equally
    // scored hits come back in whatever order the map happens to iterate, so
    // the same search returns a different order on each engine — and a test
    // comparing the two is the only place that ever notices.
    hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return hits.slice(0, opts.limit ?? 20);
  }
}

export const searchEngine = new InMemorySearchEngine();
