/**
 * Phase 11 — search service.
 *
 * Wraps the engine with enforcement: results are restricted to the caller's
 * tenant (by the engine, which reads the index as an ordinary tenant-scoped
 * entity) and to entities the caller may read (object-level permission), so
 * search never leaks records a user could not otherwise see.
 *
 * The permission filter runs AFTER the engine, on the hits it returned, which
 * means a caller who may read little gets a short list rather than a wrong one.
 * Pushing it into the query would be faster and would also mean encoding the
 * permission model into a WHERE clause — the one place it must not be
 * duplicated.
 */
import type { RequestContext } from "@/lib/context/types";
import { permissionEngine } from "@/lib/permissions/engine";
import { metrics } from "@/lib/observability/metrics";
import { searchStore } from "./store";
import type { SearchHit, SearchOptions } from "./engine";

export async function search(ctx: RequestContext, term: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  metrics.increment("search.queries");
  const hits = await searchStore().search(ctx, term, opts);
  return hits.filter((h) =>
    permissionEngine.can(ctx, { action: `${h.entity}:read`, entity: h.entity }),
  );
}
