/**
 * Outbox retention.
 *
 * A published row has done its job: the event reached its subscribers and the
 * idempotency store guards against redelivery. Keeping them forever turns the
 * outbox — which the recovery job scans on every tick — into an ever-growing
 * table whose useful contents are a handful of `pending` rows.
 *
 * `pending` and `failed` rows are never pruned. Pending means undelivered, and
 * failed means someone needs to look at it.
 */
import type { RequestContext } from "@/lib/context/types";
import { systemContext } from "@/lib/context/resolver";
import { MAX_PAGE_SIZE } from "@/lib/data/query";
import { getQueryEngine } from "@/lib/data/store";

export async function prunePublished(ctx: RequestContext, days: number): Promise<number> {
  const qe = await getQueryEngine();
  const sys = systemContext(ctx.tenantId, ctx.orgId);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  let removed = 0;
  for (;;) {
    const page = await qe.list(sys, "outboxEvent", {
      filters: [
        { field: "status", op: "eq", value: "published" },
        { field: "at", op: "lt", value: cutoff },
      ],
      pageSize: MAX_PAGE_SIZE,
    });
    if (page.items.length === 0) return removed;
    removed += await qe.removeMany(sys, "outboxEvent", page.items.map((r) => String(r.id)));
  }
}
