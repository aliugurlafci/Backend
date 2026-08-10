/**
 * Physical inventory counts.
 *
 * Three steps, each with something real to do:
 *
 *   generateSheet  freeze what the system believes, and list what to count
 *   recordCount    write down what was found
 *   postCount      move the stock to match, and put the difference in the ledger
 *
 * Everything hard about a count is in the first and last step.
 */
import type { EntityRecord } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import { BadRequestError, ConflictError } from "@/lib/enforcement/errors";
import { logger } from "@/lib/observability/logger";
import { avgCostOf } from "./costing";

const round2 = (n: number): number => Math.round(n * 100) / 100 + 0;

export interface SheetResult {
  lines: number;
  warehouseId: string;
}

/**
 * Generate the count sheet and FREEZE the system quantities.
 *
 * The freeze is the whole point. A count takes hours; sales and receipts carry
 * on. If the expected figure were read at posting time instead, every movement
 * that happened in between would land in the variance, and the person who
 * counted would be answering for a difference the system created underneath
 * them. Snapshotting means the variance measures exactly one thing: what was on
 * the shelf versus what the books said when counting began.
 *
 * Zero-quantity balances are included on purpose. "The system says none and
 * there are four" is a finding, and a sheet that only lists what the system
 * already knows about can never produce it.
 */
export async function generateSheet(ctx: RequestContext, countId: string): Promise<SheetResult> {
  const qe = await getQueryEngine();
  const count = await qe.get(ctx, "stockCount", countId);
  if (count.status !== "draft") {
    throw new ConflictError(`count ${String(count.number ?? countId)} has already been started`).withKey("err.countAlreadyStarted", { number: String(count.number ?? countId) });
  }
  const warehouseId = String(count.warehouseId ?? "");
  if (!warehouseId) throw new BadRequestError("the count has no warehouse");

  // `listComplete` raises rather than truncating: a sheet missing its last page
  // would read as "these products were not counted" and write off real stock.
  const balances = await qe.listComplete(ctx, "stockBalance", {
    filters: [{ field: "warehouseId", op: "eq", value: warehouseId }],
  });

  const filter = String(count.productFilter ?? "").trim().toLowerCase();
  const products = new Map<string, EntityRecord>();
  if (filter) {
    for (const p of await qe.listComplete(ctx, "product", {})) products.set(String(p.id), p);
  }

  let lines = 0;
  for (const balance of balances) {
    const productId = String(balance.productId);
    if (filter) {
      const product = products.get(productId);
      const haystack = `${String(product?.name ?? "")} ${String(product?.sku ?? "")}`.toLowerCase();
      if (!haystack.includes(filter)) continue;
    }
    const qty = Number(balance.qty ?? 0);
    await qe.createWithComputed(
      ctx,
      "stockCountLine",
      { stockCountId: countId, productId, systemQty: qty },
      {
        // Cost is snapshotted too, so the variance can be valued later without a
        // second lookup — and valued at what the stock was worth WHEN COUNTED,
        // which is the figure the write-off should carry.
        unitCost: avgCostOf({ qty, value: Number(balance.value ?? 0) }),
        variance: null,
        varianceValue: null,
      },
    );
    lines += 1;
  }

  await qe.patchComputed(ctx, "stockCount", countId, {
    status: "counting",
    lineCount: lines,
    countedBy: ctx.userId,
  });
  logger.info("count sheet generated", { countId, warehouseId, lines });
  return { lines, warehouseId };
}

export interface CountEntry {
  productId: string;
  countedQty: number;
  notes?: string | null;
}

/**
 * Record what was found.
 *
 * Accepts entries by product rather than by line id, because that is how a
 * scanner reports: it knows the barcode, not our row. A product that is not on
 * the sheet is ADDED — finding something the system had no balance for is a real
 * outcome and refusing it would send the counter to a different screen mid-count.
 */
export async function recordCount(
  ctx: RequestContext,
  countId: string,
  entries: CountEntry[],
): Promise<{ updated: number; added: number }> {
  const qe = await getQueryEngine();
  const count = await qe.get(ctx, "stockCount", countId);
  if (count.status !== "counting") {
    throw new ConflictError(`count ${String(count.number ?? countId)} is not open for counting`).withKey("err.countNotOpen", { number: String(count.number ?? countId) });
  }

  const existing = await qe.listComplete(ctx, "stockCountLine", {
    filters: [{ field: "stockCountId", op: "eq", value: countId }],
  });
  const byProduct = new Map(existing.map((l) => [String(l.productId), l]));

  let updated = 0;
  let added = 0;
  for (const entry of entries) {
    const countedQty = Number(entry.countedQty);
    if (!Number.isFinite(countedQty)) {
      throw new BadRequestError(`counted quantity for product ${entry.productId} is not a number`).withKey("err.countedQtyNaN", { product: entry.productId });
    }
    const line = byProduct.get(String(entry.productId));
    if (line) {
      const systemQty = Number(line.systemQty ?? 0);
      const variance = round2(countedQty - systemQty);
      await qe.patchComputed(ctx, "stockCountLine", String(line.id), {
        countedQty,
        countedAt: ctx.at,
        notes: entry.notes ?? null,
        variance,
        varianceValue: round2(variance * Number(line.unitCost ?? 0)),
      });
      updated += 1;
      continue;
    }
    // Not on the sheet: the system holds no balance for it here. Its snapshot is
    // zero, which is exactly what the system believed.
    await qe.createWithComputed(
      ctx,
      "stockCountLine",
      { stockCountId: countId, productId: entry.productId, systemQty: 0, countedQty, notes: entry.notes ?? null },
      { variance: round2(countedQty), varianceValue: 0, unitCost: 0, countedAt: ctx.at },
    );
    added += 1;
  }

  await refreshTotals(ctx, countId);
  return { updated, added };
}

/** Recompute the header's variance summary from its lines. */
async function refreshTotals(ctx: RequestContext, countId: string): Promise<void> {
  const qe = await getQueryEngine();
  const lines = await qe.listComplete(ctx, "stockCountLine", {
    filters: [{ field: "stockCountId", op: "eq", value: countId }],
  });
  let varianceCount = 0;
  let varianceValue = 0;
  for (const l of lines) {
    // A line nobody counted is not a variance of zero — it is unknown, and
    // treating it as agreement would write off nothing while claiming the shelf
    // was checked.
    if (l.countedQty === null || l.countedQty === undefined) continue;
    const variance = Number(l.variance ?? 0);
    if (variance !== 0) varianceCount += 1;
    varianceValue += Number(l.varianceValue ?? 0);
  }
  await qe.patchComputed(ctx, "stockCount", countId, {
    lineCount: lines.length,
    varianceCount,
    varianceValue: round2(varianceValue),
  });
}

export interface PostResult {
  adjustments: number;
  varianceValue: number;
  skipped: number;
}

/**
 * Post the count: move stock to match what was found.
 *
 * The movement is the VARIANCE, not the counted quantity.
 *
 * That distinction decides what happens to anything that moved during the count.
 * Setting the balance to the counted figure would silently erase every sale and
 * receipt since the snapshot — the count would quietly reverse real transactions
 * that were correctly recorded. Applying the difference keeps them: the count
 * says "there were three fewer than the books thought at that moment", and that
 * remains true regardless of what has happened since.
 *
 * Each variance becomes a `stockAdjustment`, so it flows through the costing and
 * posting path that already exists rather than a second one written here — a
 * write-off values at the running average, a write-on at the snapshot cost, and
 * both land in the same account as every other adjustment.
 */
export async function postCount(ctx: RequestContext, countId: string): Promise<PostResult> {
  const qe = await getQueryEngine();
  const count = await qe.get(ctx, "stockCount", countId);
  if (count.status === "posted") {
    throw new ConflictError(`count ${String(count.number ?? countId)} is already posted`).withKey("err.countAlreadyPosted", { number: String(count.number ?? countId) });
  }
  if (count.status !== "review") {
    throw new ConflictError("a count must be submitted for review before it can be posted");
  }

  const lines = await qe.listComplete(ctx, "stockCountLine", {
    filters: [{ field: "stockCountId", op: "eq", value: countId }],
  });

  const { postStockAdjustment } = await import("@/lib/accounting/postings");

  let adjustments = 0;
  let skipped = 0;
  let varianceValue = 0;

  for (const line of lines) {
    if (line.countedQty === null || line.countedQty === undefined) {
      skipped += 1;
      continue;
    }
    const variance = Number(line.variance ?? 0);
    if (variance === 0) continue;

    const adj = await qe.createWithComputed(
      ctx,
      "stockAdjustment",
      {
        warehouseId: count.warehouseId,
        productId: line.productId,
        qtyDelta: variance,
        // Only consulted for a write-ON; a write-off consumes the running
        // average, so a cost supplied with a negative delta is ignored.
        unitCost: Number(line.unitCost ?? 0),
        reason: `Count ${String(count.number ?? countId)}`,
        branchId: count.branchId ?? null,
        adjustedAt: String(count.countDate ?? ctx.at).slice(0, 10),
        status: "draft",
      },
      { number: `${String(count.number ?? "CNT")}-${String(line.productId)}` },
    );
    await postStockAdjustment(ctx, String(adj.id));
    adjustments += 1;
    varianceValue += Number(line.varianceValue ?? 0);
  }

  await qe.patchComputed(ctx, "stockCount", countId, {
    status: "posted",
    approvedBy: ctx.userId,
    varianceValue: round2(varianceValue),
  });
  logger.info("stock count posted", { countId, adjustments, skipped, varianceValue: round2(varianceValue) });
  return { adjustments, skipped, varianceValue: round2(varianceValue) };
}
