/**
 * Phase 11 — search service.
 *
 * Wraps the engine with enforcement: results are restricted to the caller's
 * tenant (by the engine) and to entities the caller may read (object-level
 * permission), so search never leaks records a user couldn't otherwise see.
 */
import { scopeOf } from "@/lib/context/isolation";
import type { RequestContext } from "@/lib/context/types";
import { permissionEngine } from "@/lib/permissions/engine";
import { metrics } from "@/lib/observability/metrics";
import { searchEngine, type SearchHit, type SearchOptions } from "./engine";

export function search(ctx: RequestContext, term: string, opts: SearchOptions = {}): SearchHit[] {
  metrics.increment("search.queries");
  const hits = searchEngine.search(scopeOf(ctx), term, opts);
  return hits.filter((h) =>
    permissionEngine.can(ctx, { action: `${h.entity}:read`, entity: h.entity }),
  );
}
