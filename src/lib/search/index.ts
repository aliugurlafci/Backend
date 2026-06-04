/** Phase 11 — Search barrel. */
export { InMemorySearchEngine, searchEngine } from "./engine";
export type { SearchDocument, SearchHit, SearchOptions } from "./engine";
export { buildDocument, reindexAll, registerSearchIndexing } from "./indexer";
export { search } from "./service";
