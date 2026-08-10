/**
 * Adding freight, duty and insurance to what the goods cost.
 *
 * The container was bought at 100 and is on the shelf at 118. Booking the extra
 * 18 to an expense account and valuing the stock at 100 understates inventory,
 * overstates the month's expenses, and then reports a margin on every sale out
 * of that container that was never earned. VUK md. 262 puts these inside maliyet
 * bedeli, so this is a requirement rather than a preference.
 *
 * The mechanism is deliberately the one the costing engine already has: a
 * quantity-zero, value-positive stock movement per receipt line. The balance
 * absorbs it exactly as it absorbs a receipt, the moving average moves, and
 * nothing computes a cost twice. No new arithmetic, no second source of truth.
 *
 * Allocation is over the RECEIPT's lines, not the order's. Freight is paid on
 * what turned up.
 */
import type { EntityRecord } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import { getInventoryService } from "@/lib/inventory/service";
import { getAccountingService, type JournalLineInput } from "@/lib/accounting/service";
import { BadRequestError, ConflictError } from "@/lib/enforcement/errors";
import { logger } from "@/lib/observability/logger";
import { BASE_CURRENCY } from "@/lib/config/env";

const round2 = (n: number): number => Math.round(n * 100) / 100;

export type AllocationMethod = "value" | "quantity" | "weight" | "volume";

export interface AllocationLine {
  productId: string;
  warehouseId: string;
  qtyBase: number;
  /** Line value at the supplier's price — the basis for value allocation. */
  lineValue: number;
  weightKg: number;
  volumeM3: number;
}

export interface AllocationShare extends AllocationLine {
  /** This line's share of the charge, in currency. */
  share: number;
}

/**
 * Split an amount across lines by the chosen basis.
 *
 * Pure, and separate from everything that touches a database, so the arithmetic
 * that decides how much value lands on each product can be tested exhaustively —
 * it is the part that quietly goes wrong.
 *
 * The last line absorbs the rounding remainder. Distributing a 100.00 charge
 * over three equal lines gives 33.33 three times and loses a kuruş, and a kuruş
 * that vanishes here is a kuruş by which the GL entry and the stock balances
 * disagree for ever.
 */
export function allocate(lines: readonly AllocationLine[], amount: number, method: AllocationMethod): AllocationShare[] {
  const basisOf = (l: AllocationLine): number => {
    switch (method) {
      case "quantity":
        return Math.abs(l.qtyBase);
      case "weight":
        return Math.abs(l.qtyBase) * l.weightKg;
      case "volume":
        return Math.abs(l.qtyBase) * l.volumeM3;
      default:
        return Math.abs(l.lineValue);
    }
  };

  const bases = lines.map(basisOf);
  const total = bases.reduce((t, b) => t + b, 0);

  // No basis at all — every product weighs nothing, or the receipt is valued at
  // zero. Falling back to an equal split rather than refusing: the charge is
  // real and has to land somewhere, and "spread it evenly" is the honest answer
  // when there is nothing to distinguish the lines by.
  const effective = total > 0 ? bases : lines.map(() => 1);
  const effectiveTotal = total > 0 ? total : lines.length;
  if (effectiveTotal <= 0) return [];

  const out: AllocationShare[] = [];
  let assigned = 0;
  lines.forEach((l, i) => {
    const isLast = i === lines.length - 1;
    // The last share is the remainder, not its own rounded quotient — that is
    // what makes the parts add back to the whole exactly.
    const share = isLast ? round2(amount - assigned) : round2((amount * (effective[i] ?? 0)) / effectiveTotal);
    assigned = round2(assigned + share);
    out.push({ ...l, share });
  });
  return out;
}

/** The receipt's lines, in the shape the allocator wants. */
async function receiptLines(ctx: RequestContext, grn: EntityRecord): Promise<AllocationLine[]> {
  const qe = await getQueryEngine();
  const lines = await qe.listComplete(ctx, "goodsReceiptLine", {
    filters: [{ field: "grnId", op: "eq", value: String(grn.id) }],
  });
  const stocked = lines.filter((l) => l.productId && Number(l.qtyBase ?? l.qty ?? 0) > 0);
  if (stocked.length === 0) return [];

  // Weight and volume live on the product card, so they are read once for the
  // whole receipt rather than per line.
  const productIds = [...new Set(stocked.map((l) => String(l.productId)))];
  const products = await qe.listComplete(ctx, "product", {
    filters: [{ field: "id", op: "in", value: productIds }],
  });
  const byId = new Map(products.map((p) => [String(p.id), p]));

  return stocked.map((l) => {
    const p = byId.get(String(l.productId));
    const qtyBase = Number(l.qtyBase ?? l.qty ?? 0);
    return {
      productId: String(l.productId),
      warehouseId: String(l.warehouseId ?? grn.warehouseId),
      qtyBase,
      lineValue: round2(qtyBase * Number(l.unitCost ?? 0)),
      weightKg: Number(p?.weightKg ?? 0),
      volumeM3: Number(p?.volumeM3 ?? 0),
    };
  });
}

/**
 * Preview the split without changing anything.
 *
 * Separate from applying it, because "which product ends up carrying this
 * 12.000 lira of freight" is a question people want answered before it is a
 * fact — and once applied it is in the moving average and only a void takes it
 * back out.
 */
export async function previewLandedCost(
  ctx: RequestContext,
  costId: string,
): Promise<{ landedCost: EntityRecord; shares: AllocationShare[] }> {
  const qe = await getQueryEngine();
  const cost = await qe.get(ctx, "landedCost", costId);
  const grn = await qe.get(ctx, "goodsReceipt", String(cost.grnId));
  const lines = await receiptLines(ctx, grn);
  return {
    landedCost: cost,
    shares: allocate(lines, round2(Number(cost.amount ?? 0)), String(cost.allocationMethod ?? "value") as AllocationMethod),
  };
}

/**
 * Add the charge to the goods.
 *
 * One value-only movement per product: quantity zero, value the share. The
 * balance treats it as any other inbound value, so the moving average rises and
 * every subsequent issue costs the higher figure — which is the whole point.
 *
 * Split from the lifecycle transition for the same reason `applyGRN` was: the
 * transition writes the status first, so a status guard here would make the
 * lifecycle path a silent no-op.
 */
export async function applyLandedCost(ctx: RequestContext, costId: string): Promise<number> {
  const qe = await getQueryEngine();
  const cost = await qe.get(ctx, "landedCost", costId);
  const amount = round2(Number(cost.amount ?? 0));
  if (amount <= 0) return 0;

  const grn = await qe.get(ctx, "goodsReceipt", String(cost.grnId));
  if (String(grn.status) !== "posted") {
    // The goods have to be on the shelf before their cost can be increased.
    // Against a draft receipt there are no balances to add value to, and the
    // charge would silently disappear.
    throw new ConflictError("the goods receipt must be posted before landed costs can be applied");
  }

  const lines = await receiptLines(ctx, grn);
  if (lines.length === 0) throw new BadRequestError("this receipt has no stock lines to allocate onto");

  const shares = allocate(lines, amount, String(cost.allocationMethod ?? "value") as AllocationMethod);
  const inventory = await getInventoryService();
  let applied = 0;

  await qe.runInTransaction(async () => {
    for (const s of shares) {
      if (s.share === 0) continue;
      // Quantity zero, value only. `writeMovement` derives its arithmetic from
      // the sign of the quantity, and zero is neither an inbound nor an outbound
      // move — it adds `unitCost × qty`, which would be nothing. So the value is
      // carried as a one-unit-equivalent cost against a zero quantity... which
      // the costing engine cannot express. Hence `adjustValue` below.
      const result = await inventory.adjustValue(ctx, {
        productId: s.productId,
        warehouseId: s.warehouseId,
        valueDelta: s.share,
        ref: costId,
        refType: "landedCost",
        branchId: (cost.branchId as string) ?? null,
        movedAt: String(cost.costDate ?? ctx.at),
      });
      applied = round2(applied + result.valueDelta);
    }
  });

  logger.info("landed cost applied", { costId, amount, lines: shares.length });
  return applied;
}

export interface VoidResult {
  /** Taken back out of the stock balances. Negative. */
  fromInventory: number;
  /**
   * What the balances could not give back, because those goods have already
   * been sold. Belongs against the cost of what left, not against stock that is
   * no longer there.
   */
  fromCogs: number;
}

/** Take an applied charge back out of the balances it was added to. */
export async function voidLandedCost(ctx: RequestContext, costId: string): Promise<VoidResult> {
  const qe = await getQueryEngine();
  const applied = await qe.listComplete(ctx, "stockMovement", {
    filters: [
      { field: "ref", op: "eq", value: costId },
      { field: "refType", op: "eq", value: "landedCost" },
      { field: "type", op: "eq", value: "adjustment" },
    ],
  });
  const original = applied.filter((m) => Number(m.value ?? 0) > 0);
  if (original.length === 0) return { fromInventory: 0, fromCogs: 0 };

  const cost = await qe.get(ctx, "landedCost", costId);
  const inventory = await getInventoryService();
  let fromInventory = 0;
  let fromCogs = 0;

  await qe.runInTransaction(async () => {
    for (const mv of original) {
      // Exactly what was added, negated — read back from the movement rather
      // than re-allocated. Re-running the split would produce a different answer
      // if a receipt line had been edited since, and the void would leave a
      // residue in the balance.
      const result = await inventory.adjustValue(ctx, {
        productId: String(mv.productId),
        warehouseId: String(mv.warehouseId),
        valueDelta: -round2(Number(mv.value ?? 0)),
        ref: `${costId}:void`,
        refType: "landedCost",
        branchId: (cost.branchId as string) ?? null,
        movedAt: ctx.at,
      });
      fromInventory = round2(fromInventory + result.valueDelta);
      // What the balance could not absorb: the goods it belonged to have gone,
      // and their cost went with them.
      fromCogs = round2(fromCogs + result.residual);
    }
  });

  if (fromCogs !== 0) {
    logger.warn("landed-cost reversal exceeded the value still on hand; the remainder corrects COGS", {
      costId,
      fromInventory,
      fromCogs,
    });
  }
  logger.info("landed cost voided", { costId, fromInventory, fromCogs });
  return { fromInventory, fromCogs };
}

/**
 * The GL side: Dr Inventory, Cr the accrual the charge was billed against.
 *
 * Credited to GR/IR rather than to an expense account: the freight invoice, when
 * it arrives, is a payable that clears the same accrual — exactly as a supplier
 * invoice clears the accrual raised by its goods receipt. Posting the credit
 * straight to an expense account would put the cost in both inventory AND the
 * income statement.
 */
export async function postLandedCostGL(ctx: RequestContext, costId: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  const qe = await getQueryEngine();
  const acc = await getAccountingService();
  const cost = await qe.get(ctx, "landedCost", costId);
  const magnitude = round2(amount);

  await acc.postFromSource(ctx, {
    source: "landedCost",
    currencyCode: BASE_CURRENCY,
    sourceRef: costId,
    date: String(cost.costDate ?? ctx.at).slice(0, 10),
    memo: `${String(cost.costType ?? "landed cost")} — ${String(cost.number ?? costId)}`,
    branchId: (cost.branchId as string) ?? null,
    lines: [
      { ledgerAccountId: await acc.requireAccount(ctx, "inventory"), debit: magnitude },
      { ledgerAccountId: await acc.requireAccount(ctx, "gr_ir"), credit: magnitude },
    ],
  });
}

/**
 * Reverse the charge in the ledger.
 *
 * Two credits, not one: what came back out of stock credits Inventory, and what
 * could not — because those goods have been sold — credits COGS. Putting the
 * whole reversal against Inventory would credit an account that no longer holds
 * the value, leaving the GL below the stock ledger by the difference for ever.
 */
export async function reverseLandedCostGL(ctx: RequestContext, costId: string, result: VoidResult): Promise<void> {
  const inventoryPart = round2(-result.fromInventory);
  const cogsPart = round2(-result.fromCogs);
  const total = round2(inventoryPart + cogsPart);
  if (total <= 0) return;

  const qe = await getQueryEngine();
  const acc = await getAccountingService();
  const cost = await qe.get(ctx, "landedCost", costId);

  const lines: JournalLineInput[] = [{ ledgerAccountId: await acc.requireAccount(ctx, "gr_ir"), debit: total }];
  if (inventoryPart > 0) {
    lines.push({ ledgerAccountId: await acc.requireAccount(ctx, "inventory"), credit: inventoryPart });
  }
  if (cogsPart > 0) {
    lines.push({ ledgerAccountId: await acc.requireAccount(ctx, "cogs"), credit: cogsPart });
  }

  await acc.postFromSource(ctx, {
    source: "landedCostVoid",
    currencyCode: BASE_CURRENCY,
    sourceRef: costId,
    date: today(ctx),
    memo: `Void ${String(cost.number ?? costId)}`,
    branchId: (cost.branchId as string) ?? null,
    lines,
  });
}

const today = (ctx: RequestContext): string => ctx.at.slice(0, 10);
