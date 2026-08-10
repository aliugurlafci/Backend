/**
 * Balance ↔ ledger reconciliation.
 *
 * `stockBalance` is a running total maintained beside the `stockMovement`
 * ledger, in the same transaction as every movement. Because each movement
 * records verbatim the `valueDelta` that was applied to the balance, the two
 * must agree **to the cent** — that equality is only achievable because cost is
 * computed once, in `writeMovement`, rather than derived independently in the
 * posting code.
 *
 * So drift is not something to quietly repair on a schedule: it means a write
 * path bypassed the service, or a transaction committed half its work. The job
 * therefore runs in report-only mode and a non-zero result is an alert. `apply`
 * exists for the operator who has diagnosed the cause and wants the totals
 * rebuilt from the ledger, which remains the record of what happened.
 */
import type { RequestContext } from "@/lib/context/types";
import type { Filter } from "@/lib/data/query";
import { getQueryEngine } from "@/lib/data/store";
import { logger } from "@/lib/observability/logger";
import { round2 } from "./costing";
import { stockKeyOf } from "./service";

export interface DriftRow {
  stockKey: string;
  productId: string;
  warehouseId: string;
  ledgerQty: number;
  balanceQty: number;
  ledgerValue: number;
  balanceValue: number;
}

export interface ReconcileResult {
  checked: number;
  drifted: DriftRow[];
  repaired: number;
}

export interface ReconcileOptions {
  /** Rewrite drifted balances from the ledger. Off by default — see the note above. */
  apply?: boolean;
  productId?: string;
  warehouseId?: string;
}

/** Cent-level tolerance: both sides are rounded to 2dp, so anything above this is real. */
const EPSILON = 0.005;

export async function reconcileStockBalances(
  ctx: RequestContext,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const qe = await getQueryEngine();

  const filters: Filter[] = [];
  if (opts.productId) filters.push({ field: "productId", op: "eq", value: opts.productId });
  if (opts.warehouseId) filters.push({ field: "warehouseId", op: "eq", value: opts.warehouseId });

  // The one place a full aggregation over the movement history still happens —
  // and it runs on a schedule, not on the checkout path.
  const ledger = await qe.aggregate(ctx, "stockMovement", {
    filters,
    // Grouped by LOT as well, because that is the identity of a balance row for
    // a lot-tracked product. Aggregating only by (product, warehouse) would
    // compare one ledger total against several balances and report every batch
    // as drift.
    dimensions: [{ field: "productId" }, { field: "warehouseId" }, { field: "lotId" }],
    measures: [
      { op: "sum", field: "qty", as: "qty" },
      { op: "sum", field: "value", as: "value" },
    ],
  });

  const truth = new Map<string, { productId: string; warehouseId: string; qty: number; value: number }>();
  for (const row of ledger) {
    const productId = String(row.keys.productId ?? "");
    const warehouseId = String(row.keys.warehouseId ?? "");
    if (!productId || !warehouseId) continue;
    const lotId = row.keys.lotId ? String(row.keys.lotId) : null;
    truth.set(stockKeyOf(productId, warehouseId, lotId), {
      productId,
      warehouseId,
      qty: round2(row.measures.qty ?? 0),
      value: round2(row.measures.value ?? 0),
    });
  }

  const drifted: DriftRow[] = [];
  let checked = 0;
  const seen = new Set<string>();

  await qe.listAll(ctx, "stockBalance", { filters }, (batch) => {
    for (const bal of batch) {
      const balanceQtyRaw = Number(bal.qty ?? 0);
      const balanceValueRaw = Number(bal.value ?? 0);
      const stockKey = String(bal.stockKey);
      seen.add(stockKey);
      // An empty row that no movement produced is not drift.
      //
      // A lot-tracked product's reservations are held on a (product, warehouse)
      // header row carrying no stock — the goods live in the per-lot rows. It is
      // a bookkeeping row for holds, and expecting the ledger to explain a zero
      // it never wrote would report every such product as broken.
      if (!truth.has(stockKey) && balanceQtyRaw === 0 && balanceValueRaw === 0) continue;
      checked++;
      const expected = truth.get(stockKey) ?? { productId: String(bal.productId), warehouseId: String(bal.warehouseId), qty: 0, value: 0 };
      const balanceQty = round2(Number(bal.qty ?? 0));
      const balanceValue = round2(Number(bal.value ?? 0));
      if (Math.abs(expected.qty - balanceQty) > EPSILON || Math.abs(expected.value - balanceValue) > EPSILON) {
        drifted.push({
          stockKey,
          productId: expected.productId,
          warehouseId: expected.warehouseId,
          ledgerQty: expected.qty,
          balanceQty,
          ledgerValue: expected.value,
          balanceValue,
        });
      }
    }
  });

  // A stock key the ledger knows about but no balance row covers — the balance
  // write was lost, which is drift of the most consequential kind.
  for (const [stockKey, expected] of truth) {
    if (seen.has(stockKey)) continue;
    checked++;
    drifted.push({
      stockKey,
      productId: expected.productId,
      warehouseId: expected.warehouseId,
      ledgerQty: expected.qty,
      balanceQty: 0,
      ledgerValue: expected.value,
      balanceValue: 0,
    });
  }

  let repaired = 0;
  if (opts.apply) {
    for (const d of drifted) {
      await qe.runInTransaction(async () => {
        const bal = await qe.getForUpdate(ctx, "stockBalance", [{ field: "stockKey", op: "eq", value: d.stockKey }]);
        const avgCost = d.ledgerQty > 0 ? round2(d.ledgerValue / d.ledgerQty) : 0;
        if (bal) {
          await qe.patchComputed(
            ctx,
            "stockBalance",
            bal.id,
            { qty: d.ledgerQty, value: d.ledgerValue, avgCost },
            Number(bal.version),
          );
        } else {
          await qe.createWithComputed(
            ctx,
            "stockBalance",
            { productId: d.productId, warehouseId: d.warehouseId, branchId: null, qty: d.ledgerQty, value: d.ledgerValue },
            { stockKey: d.stockKey, avgCost },
          );
        }
      });
      repaired++;
    }
  }

  if (drifted.length > 0) {
    logger.warn("stock balances drifted from the ledger", {
      checked,
      drifted: drifted.length,
      repaired,
      sample: drifted.slice(0, 5),
    });
  }

  return { checked, drifted, repaired };
}
