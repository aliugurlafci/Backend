/**
 * Which search index this deployment uses.
 *
 * The same decision, made the same way, as `data/store.ts` makes for the
 * repository: SQL when the platform is persistent, in-memory when it is not.
 * Deciding it here rather than at each call site is what lets the indexer and
 * the search service stay ignorant of which one they are talking to.
 *
 * The in-memory engine is not a fallback for SQL being unavailable — a database
 * that is down should surface as an error, not as a search that quietly returns
 * an empty index and looks like "no results".
 */
import { usingInMemoryBackends } from "@/lib/config/env";
import { InMemorySearchEngine, type SearchEngine } from "./engine";
import { SqlSearchEngine } from "./sql-engine";

let engine: SearchEngine | null = null;

export function searchStore(): SearchEngine {
  engine ??= usingInMemoryBackends ? new InMemorySearchEngine() : new SqlSearchEngine();
  return engine;
}

/** Swap the engine — tests only, so a case can exercise either implementation. */
export function setSearchStore(next: SearchEngine | null): void {
  engine = next;
}
