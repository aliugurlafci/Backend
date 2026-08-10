/**
 * Sending goods back to a supplier.
 *
 * The customer side has always existed; this side did not, so a damaged pallet
 * had nowhere to go. It was either left on the books as stock we did not have,
 * or written off — which puts the cost in the P&L rather than on the supplier's
 * account, and the next payment run pays for goods that went back.
 *
 * One entry, not two, and its shape depends on whether the goods were already
 * BILLED:
 *
 *   billed    — Dr AP 320, Cr İndirilecek KDV 191, Cr Ticari Mallar 153
 *   not yet   — Dr GR/IR 326,                      Cr Ticari Mallar 153
 *
 * Inventory is credited at the MOVING AVERAGE, because that is what actually
 * left the shelf. Once other receipts have blended into the balance, removing
 * the price the supplier charged takes out value the balance no longer carries
 * and leaves Inventory permanently adrift — the rule `reverseGoodsReceipt`
 * follows, for the same reason.
 *
 * Which means the two sides rarely match to the kuruş, and the difference is
 * real: it is the gap between what we are being credited and what the goods were
 * carried at. It goes to price variance (653), where the three-way match already
 * puts the same kind of difference. Forcing the entry to balance by fudging
 * either side would hide it.
 *
 * İndirilecek KDV, not Hesaplanan: the VAT on goods sent back is input VAT that
 * is no longer deductible. Reversing 391 instead would understate what is owed
 * on the period's beyanname.
 */
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import { getInventoryService } from "@/lib/inventory/service";
import { getAccountingService, type JournalLineInput } from "@/lib/accounting/service";
import { collapseMovementLines } from "@/lib/inventory/movement-lines";
import { ConflictError } from "@/lib/enforcement/errors";
import { logger } from "@/lib/observability/logger";
import { BASE_CURRENCY } from "@/lib/config/env";

const round2 = (n: number): number => Math.round(n * 100) / 100;
const today = (ctx: RequestContext): string => ctx.at.slice(0, 10);

/**
 * Post a return: goods out, payable down.
 *
 * Split from the lifecycle transition for the same reason `applyGRN` was — the
 * transition sets the status first, so a status guard here would make the
 * lifecycle path a silent no-op.
 */
export async function postPurchaseReturn(ctx: RequestContext, returnId: string): Promise<void> {
  const qe = await getQueryEngine();
  const acc = await getAccountingService();
  const inventory = await getInventoryService();
  const doc = await qe.get(ctx, "purchaseReturn", returnId);
  const warehouseId = String(doc.warehouseId ?? "");
  if (!warehouseId) throw new ConflictError("a purchase return needs a warehouse — the goods leave one");

  const lines = await qe.listComplete(ctx, "purchaseReturnLine", {
    filters: [{ field: "returnId", op: "eq", value: returnId }],
  });

  // One movement per product, as everywhere else: `writeMovement` is idempotent
  // on (ref, refType, product, warehouse, type), so two lines of the same item
  // would have the second returned as a duplicate and never taken off the shelf.
  //
  // Base units — a return of one case is twelve pieces leaving.
  const movements = collapseMovementLines(
    lines
      .filter((l) => l.productId && Number(l.qty ?? 0) > 0)
      .map((l) => ({
        productId: String(l.productId),
        warehouseId,
        qtyBase: -Number(l.qtyBase ?? l.qty ?? 0),
      })),
  );

  let stockValue = 0;
  await qe.runInTransaction(async () => {
    for (const mv of movements) {
      const result = await inventory.writeMovement(ctx, {
        productId: mv.productId,
        warehouseId: mv.warehouseId,
        qty: mv.qtyBase,
        type: "issue",
        // No `unitCost`: an outbound movement costs the balance's moving
        // average. Passing the supplier's price here is exactly the drift the
        // costing engine was rebuilt to remove.
        ref: returnId,
        refType: "purchaseReturn",
        branchId: (doc.branchId as string) ?? null,
        movedAt: String(doc.returnDate ?? ctx.at),
      });
      stockValue = round2(stockValue + -result.valueDelta);
    }
  });

  const total = round2(Number(doc.total ?? 0));
  const tax = round2(Number(doc.taxTotal ?? 0));
  const net = round2(total - tax);
  if (stockValue <= 0 && total <= 0) return;

  const billed = Boolean(doc.vendorBillId);
  const entry: JournalLineInput[] = [];

  if (billed) {
    // The supplier owes us the whole invoiced amount back, VAT included.
    entry.push({ ledgerAccountId: await acc.requireAccount(ctx, "accounts_payable"), debit: total });
    if (tax > 0) {
      entry.push({ ledgerAccountId: await acc.requireAccount(ctx, "vat_deductible"), credit: tax });
    }
  } else {
    // Never invoiced, so nothing is payable — what reverses is the accrual the
    // receipt raised. Posting to AP here would leave the supplier's account
    // showing a credit that no invoice will ever clear.
    entry.push({ ledgerAccountId: await acc.requireAccount(ctx, "gr_ir"), debit: net > 0 ? net : stockValue });
  }

  if (stockValue > 0) {
    entry.push({ ledgerAccountId: await acc.requireAccount(ctx, "inventory"), credit: stockValue });
  }

  // Whatever the two sides do not cover: the gap between the credit and what the
  // goods were carried at. Named rather than fudged.
  const debits = round2(entry.reduce((t, l) => t + (l.debit ?? 0), 0));
  const credits = round2(entry.reduce((t, l) => t + (l.credit ?? 0), 0));
  const variance = round2(debits - credits);
  if (variance !== 0) {
    const ppv = await acc.requireAccount(ctx, "purchase_price_variance");
    entry.push(variance > 0 ? { ledgerAccountId: ppv, credit: variance } : { ledgerAccountId: ppv, debit: -variance });
  }

  await acc.postFromSource(ctx, {
    source: "purchaseReturn",
    currencyCode: String(doc.currencyCode ?? BASE_CURRENCY),
    sourceRef: returnId,
    date: String(doc.returnDate ?? today(ctx)),
    memo: `Alım iadesi ${String(doc.number ?? returnId)}`,
    branchId: (doc.branchId as string) ?? null,
    lines: entry,
  });

  logger.info("purchase return posted", { returnId, stockValue, total, lines: movements.length });
}

/** Void a posted return: the goods come back in at the value that left. */
export async function voidPurchaseReturn(ctx: RequestContext, returnId: string): Promise<void> {
  const qe = await getQueryEngine();
  const acc = await getAccountingService();
  const inventory = await getInventoryService();
  const doc = await qe.get(ctx, "purchaseReturn", returnId);

  const issued = await qe.listComplete(ctx, "stockMovement", {
    filters: [
      { field: "ref", op: "eq", value: returnId },
      { field: "refType", op: "eq", value: "purchaseReturn" },
      { field: "type", op: "eq", value: "issue" },
    ],
  });
  if (issued.length === 0) return; // never posted

  let restored = 0;
  await qe.runInTransaction(async () => {
    for (const mv of [...issued].sort((a, b) => String(a.productId).localeCompare(String(b.productId)))) {
      const qty = Math.abs(Number(mv.qty ?? 0));
      if (qty <= 0) continue;
      const result = await inventory.writeMovement(ctx, {
        productId: String(mv.productId),
        warehouseId: String(mv.warehouseId),
        qty,
        type: "receipt",
        // The exact unit value that left, so the void lands Inventory back where
        // it started rather than at today's average.
        unitCost: round2(Math.abs(Number(mv.value ?? 0)) / qty),
        ref: `${returnId}:void`,
        refType: "purchaseReturn",
        branchId: (doc.branchId as string) ?? null,
        movedAt: ctx.at,
      });
      restored = round2(restored + result.valueDelta);
    }
  });

  const total = round2(Number(doc.total ?? 0));
  const tax = round2(Number(doc.taxTotal ?? 0));
  const net = round2(total - tax);
  const billed = Boolean(doc.vendorBillId);

  // The exact mirror of what posting wrote: every debit becomes a credit. Built
  // from the same figures rather than re-derived, so a void cannot leave a
  // residue behind.
  const lines: JournalLineInput[] = [];
  if (billed) {
    lines.push({ ledgerAccountId: await acc.requireAccount(ctx, "accounts_payable"), credit: total });
    if (tax > 0) lines.push({ ledgerAccountId: await acc.requireAccount(ctx, "vat_deductible"), debit: tax });
  } else {
    lines.push({ ledgerAccountId: await acc.requireAccount(ctx, "gr_ir"), credit: net > 0 ? net : restored });
  }
  if (restored > 0) {
    lines.push({ ledgerAccountId: await acc.requireAccount(ctx, "inventory"), debit: restored });
  }
  const debits = round2(lines.reduce((t, l) => t + (l.debit ?? 0), 0));
  const credits = round2(lines.reduce((t, l) => t + (l.credit ?? 0), 0));
  const variance = round2(debits - credits);
  if (variance !== 0) {
    const ppv = await acc.requireAccount(ctx, "purchase_price_variance");
    lines.push(variance > 0 ? { ledgerAccountId: ppv, credit: variance } : { ledgerAccountId: ppv, debit: -variance });
  }

  if (lines.length > 0) {
    await acc.postFromSource(ctx, {
      source: "purchaseReturnVoid",
      currencyCode: String(doc.currencyCode ?? BASE_CURRENCY),
      sourceRef: returnId,
      date: today(ctx),
      memo: `Void alım iadesi ${String(doc.number ?? returnId)}`,
      branchId: (doc.branchId as string) ?? null,
      lines,
    });
  }

  logger.info("purchase return voided", { returnId, restored });
}
