/**
 * What to order, how much, and from whom.
 *
 * `reorderLevel` existed and its only consumer was a red "Low" badge. A badge is
 * not a decision: somebody still had to work out how much to buy, from which
 * supplier, and whether it was already too late — per product, by hand, from a
 * screen that showed one number.
 *
 * The four inputs this needs all live on the product now (see Faz 7.1):
 *
 *  - `reorderLevel`  — the line below which we act
 *  - `maxStock`      — how far back up to fill. Without it the only sensible
 *                      order is "back to the reorder level", which puts you one
 *                      sale away from ordering again.
 *  - `reorderQty`    — the supplier's case size or MOQ. Ordering 7 when they
 *                      ship in 12s means receiving 12 and a discrepancy.
 *  - `leadTimeDays`  — the difference between "order this week" and "this is
 *                      already late". A product that takes 30 days to arrive is
 *                      urgent at the reorder level; one that arrives tomorrow
 *                      is not.
 *
 * A suggestion, deliberately — not an order. It proposes; a person decides.
 * Software that raises purchase orders on its own is software that buys a pallet
 * of something because a stocktake was keyed in wrong.
 */
import type { RequestContext } from "@/lib/context/types";
import type { Filter } from "@/lib/data/query";
import { getDomainService } from "@/lib/domain";
import { getInventoryService } from "@/lib/inventory/service";

export interface ReplenishRow {
  productId: string;
  productName: string;
  sku: string;
  onHand: number;
  /** Held for orders that have not shipped — promised, and not available to sell. */
  reserved: number;
  /** What is genuinely free: on hand less what is already promised. */
  available: number;
  reorderLevel: number;
  maxStock: number;
  /** What we propose buying, rounded up to the order multiple. */
  suggestedQty: number;
  leadTimeDays: number;
  supplierId: string | null;
  supplierName: string | null;
  /**
   * How pressing this is.
   *
   * `critical` when there is nothing free at all — the next customer is told no.
   * `urgent` when the lead time means ordering today still arrives late.
   * `normal` otherwise.
   */
  urgency: "critical" | "urgent" | "normal";
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/**
 * Round an order up to the supplier's multiple.
 *
 * Up, never down: rounding down means ordering less than the shortfall, which
 * leaves the product below its reorder level immediately after the delivery
 * arrives and produces the same suggestion again next week.
 */
function roundToMultiple(qty: number, multiple: number): number {
  if (!(multiple > 0)) return round4(qty);
  return round4(Math.ceil(qty / multiple - 1e-9) * multiple);
}

export interface ReplenishOptions {
  warehouseId?: string;
  /**
   * Include products that are below their level but for which nothing needs
   * ordering yet — used by the screen that lists everything it is watching.
   */
  includeCovered?: boolean;
}

/**
 * The replenishment proposal.
 *
 * Reads AVAILABLE stock, not on-hand. Twenty on the shelf with eighteen promised
 * to a confirmed order is two — and buying against the twenty is how the order
 * that promised them gets shipped late.
 */
export async function suggestReplenishment(
  ctx: RequestContext,
  opts: ReplenishOptions = {},
): Promise<{ rows: ReplenishRow[] }> {
  const domain = await getDomainService();

  // Only the products somebody has configured. That set is small and
  // deliberate — a reorder level is a decision, and a catalogue-wide scan would
  // propose buying things nobody has ever chosen to stock.
  const tracked = await domain.listComplete(ctx, "product", {
    filters: [
      { field: "trackStock", op: "eq", value: true },
      { field: "active", op: "eq", value: true },
    ],
  });
  const watched = tracked.filter((p) => Number(p.reorderLevel ?? 0) > 0);
  if (watched.length === 0) return { rows: [] };

  const balanceFilters: Filter[] = [{ field: "productId", op: "in", value: watched.map((p) => String(p.id)) }];
  if (opts.warehouseId) balanceFilters.push({ field: "warehouseId", op: "eq", value: opts.warehouseId });

  const inventory = await getInventoryService();
  const balances = await inventory.onHandByKey(ctx, balanceFilters);
  const onHandBy = new Map<string, number>();
  const reservedBy = new Map<string, number>();
  for (const b of balances) {
    onHandBy.set(b.productId, round4((onHandBy.get(b.productId) ?? 0) + b.onHand));
    reservedBy.set(b.productId, round4((reservedBy.get(b.productId) ?? 0) + (b.reserved ?? 0)));
  }

  const supplierIds = [...new Set(watched.map((p) => String(p.preferredSupplierId ?? "")).filter(Boolean))];
  const suppliers = supplierIds.length ? await domain.listByIds(ctx, "supplier", supplierIds) : [];
  const supplierName = new Map(suppliers.map((s) => [String(s.id), String(s.name)]));

  const rows: ReplenishRow[] = [];
  for (const p of watched) {
    const id = String(p.id);
    const onHand = onHandBy.get(id) ?? 0;
    const reserved = reservedBy.get(id) ?? 0;
    const available = round4(onHand - reserved);
    const reorderLevel = Number(p.reorderLevel ?? 0);
    if (available > reorderLevel && !opts.includeCovered) continue;

    // Fill back up to `maxStock` when one is set. Without one, back to the
    // reorder level — the least that clears the condition, and honest about the
    // fact that nobody has said how much they actually want to hold.
    const target = Number(p.maxStock ?? 0) > reorderLevel ? Number(p.maxStock) : reorderLevel;
    const shortfall = Math.max(0, round4(target - available));
    const suggestedQty = roundToMultiple(shortfall, Number(p.reorderQty ?? 0));
    if (suggestedQty <= 0 && !opts.includeCovered) continue;

    const leadTimeDays = Number(p.leadTimeDays ?? 0);
    const urgency: ReplenishRow["urgency"] =
      available <= 0 ? "critical" : leadTimeDays > 0 && available <= reorderLevel ? "urgent" : "normal";

    const supplierId = p.preferredSupplierId ? String(p.preferredSupplierId) : null;
    rows.push({
      productId: id,
      productName: String(p.name),
      sku: String(p.sku ?? ""),
      onHand,
      reserved,
      available,
      reorderLevel,
      maxStock: Number(p.maxStock ?? 0),
      suggestedQty,
      leadTimeDays,
      supplierId,
      supplierName: supplierId ? (supplierName.get(supplierId) ?? null) : null,
      urgency,
    });
  }

  // Worst first: nothing free, then late, then everything else — and within a
  // band the one furthest below its level.
  const rank = { critical: 0, urgent: 1, normal: 2 } as const;
  rows.sort((a, b) => rank[a.urgency] - rank[b.urgency] || a.available - b.available);
  return { rows };
}
