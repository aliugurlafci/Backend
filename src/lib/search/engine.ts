/**
 * Phase 11 — search engine abstraction + in-memory index.
 *
 * A maintained document index (separate from the source of truth) kept fresh by
 * the event-driven indexer. The same interface fronts an external engine
 * (OpenSearch/Typesense) in production.
 */
import type { TenantScope } from "@/lib/context/types";

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

function scoreDoc(doc: SearchDocument, needle: string): number {
  const title = doc.title.toLowerCase();
  const text = doc.text.toLowerCase();
  let score = 0;
  if (title.includes(needle)) score += 3;
  if (title.startsWith(needle)) score += 2;
  if (text.includes(needle)) score += 1;
  return score;
}

export class InMemorySearchEngine {
  private docs = new Map<string, SearchDocument>();

  private key(entity: string, id: string): string {
    return `${entity}:${id}`;
  }

  index(doc: SearchDocument): void {
    this.docs.set(this.key(doc.entity, doc.id), doc);
  }

  remove(entity: string, id: string): void {
    this.docs.delete(this.key(entity, id));
  }

  clear(): void {
    this.docs.clear();
  }

  size(): number {
    return this.docs.size;
  }

  search(scope: TenantScope, term: string, opts: SearchOptions = {}): SearchHit[] {
    const needle = term.trim().toLowerCase();
    if (!needle) return [];
    const hits: SearchHit[] = [];
    for (const doc of this.docs.values()) {
      if (doc.tenantId !== scope.tenantId || doc.orgId !== scope.orgId) continue;
      if (opts.entities && !opts.entities.includes(doc.entity)) continue;
      const score = scoreDoc(doc, needle);
      if (score > 0) hits.push({ entity: doc.entity, id: doc.id, title: doc.title, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, opts.limit ?? 20);
  }
}

export const searchEngine = new InMemorySearchEngine();
