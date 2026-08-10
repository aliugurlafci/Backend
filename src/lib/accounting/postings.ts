/**
 * Auto-posting — turns sub-ledger events into balanced GL entries (and stock
 * movements). Every function is idempotent via the AccountingService
 * (source+sourceRef) and InventoryService (ref+refType), so retries never
 * double-post. Payment + GRN postings are invoked synchronously from their
 * service methods; invoice posting is triggered by the `invoice.send` transition
 * event (see registerAccountingPostings).
 */
import type { EntityRecord } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import { eventBus, type DomainEvent } from "@/lib/workflow/event-bus";
import { systemContext } from "@/lib/context/resolver";
import { getQueryEngine } from "@/lib/data/store";
import { logger } from "@/lib/observability/logger";
import { AccountingError, getAccountingService, type JournalLineInput } from "./service";
import { getInventoryService } from "@/lib/inventory/service";
import { collapseMovementLines } from "@/lib/inventory/movement-lines";
import { inboundSettlementSubtype, outboundSettlementSubtype } from "@/lib/finance/settlement";
import { postChequeBounced, postChequeCleared, postChequeEndorsed } from "./cheque-postings";
import { BASE_CURRENCY } from "@/lib/config/env";

const round2 = (n: number): number => Math.round(n * 100) / 100;
const today = (ctx: RequestContext): string => ctx.at.slice(0, 10);

/** Customer invoice → Dr AR, Cr Revenue (+ Cr Tax), then COGS for stock lines.
 *  The AR entry, the stock issue and the COGS entry commit together (atomic). */
export async function postInvoiceGL(ctx: RequestContext, invoiceId: string): Promise<void> {
  const qe = await getQueryEngine();
  const acc = await getAccountingService();
  const inv = await qe.get(ctx, "invoice", invoiceId);
  const total = round2(Number(inv.total ?? 0));
  if (total <= 0) return;
  const subtotal = round2(Number(inv.subtotal ?? 0));
  const tax = round2(Number(inv.taxTotal ?? 0));

  await qe.runInTransaction(async () => {
    const lines: JournalLineInput[] = [
      { ledgerAccountId: await acc.requireAccount(ctx, "accounts_receivable"), debit: total },
      { ledgerAccountId: await acc.requireAccount(ctx, "sales_revenue"), credit: subtotal },
    ];
    // KDV tevkifatı: 391 is credited only with the VAT the seller actually
    // collects. The withheld part is remitted by the BUYER, so booking the full
    // VAT here would overstate what we owe by exactly that amount. `total`
    // already excludes it (see FinanceService.replaceLines), which is why the
    // entry still balances.
    const collectibleTax = round2(tax - round2(Number(inv.tevkifatTotal ?? 0)));
    if (collectibleTax > 0) {
      lines.push({ ledgerAccountId: await acc.requireAccount(ctx, "tax_payable"), credit: collectibleTax });
    }

    await acc.postFromSource(ctx, {
      source: "invoice",
      currencyCode: String(inv.currencyCode ?? BASE_CURRENCY),
      sourceRef: invoiceId,
      date: String(inv.issueDate ?? today(ctx)),
      memo: `Invoice ${String(inv.number)}`,
      branchId: (inv.branchId as string) ?? null,
      lines,
    });

    await postInvoiceCOGS(ctx, inv);
  });
}

/**
 * Resolve the warehouse an invoice issues stock from: its explicit warehouse
 * (POS / picking), else its branch's warehouse.
 *
 * There is deliberately no "any warehouse" fallback. It used to end
 * `?? (await qe.list(ctx, "warehouse", { pageSize: 1 })).items[0]` — so on a
 * multi-warehouse setup an invoice with neither hint silently issued stock from
 * whichever row the database happened to return first, moving real quantity and
 * real value out of an arbitrary location. Failing here instead routes the
 * problem into the posting-failure retry queue, where it is visible and fixable.
 */
async function resolveIssueWarehouse(ctx: RequestContext, inv: EntityRecord): Promise<EntityRecord | undefined> {
  const qe = await getQueryEngine();
  const explicitWh = inv.warehouseId ? await qe.get(ctx, "warehouse", String(inv.warehouseId)).catch(() => undefined) : undefined;
  if (explicitWh) return explicitWh;
  if (inv.branchId) {
    const branchWh = (
      await qe.list(ctx, "warehouse", { filters: [{ field: "branchId", op: "eq", value: inv.branchId }], pageSize: 1 })
    ).items[0];
    if (branchWh) return branchWh;
  }
  throw new AccountingError(
    `invoice ${String(inv.number ?? inv.id)} has no warehouse and its branch has none — cannot decide where to issue stock from`,
  ).withKey("err.invoiceNoWarehouse", { number: String(inv.number ?? inv.id) });
}

/** Issue stock + post COGS for each stock-tracked invoice line. */
async function postInvoiceCOGS(ctx: RequestContext, inv: EntityRecord): Promise<void> {
  const qe = await getQueryEngine();
  const acc = await getAccountingService();
  const inventory = await getInventoryService();

  // Goods invoiced from a delivery note have ALREADY left, and their cost left
  // Inventory with them. Issuing again here would take the same units off the
  // shelf twice and double the COGS — the invoice would show a gross loss and
  // the warehouse would show stock it still has.
  //
  // Checked against the delivery notes rather than a flag on the invoice: the
  // note is what records the dispatch, and a flag is something that can be set
  // without goods having moved.
  const delivered = await qe.list(ctx, "deliveryNote", {
    filters: [
      { field: "invoiceId", op: "eq", value: inv.id },
      { field: "status", op: "eq", value: "posted" },
    ],
    pageSize: 1,
  });
  if (delivered.total > 0) {
    logger.info("invoice fulfilled by delivery note — stock already issued at dispatch", {
      invoice: String(inv.number ?? inv.id),
    });
    return;
  }

  const lines = await qe.listComplete(ctx, "invoiceLine", {
    filters: [{ field: "invoiceId", op: "eq", value: inv.id }],
  });

  // Resolve the warehouse only once we know stock is actually moving. Removing
  // the arbitrary "any warehouse" fallback made this throw, which turned a
  // service-only invoice — no stock lines at all — into a failed posting.
  const candidates = lines.filter((l) => l.productId && Number(l.qty ?? 0) > 0);
  if (candidates.length === 0) return;

  // `trackStock` is checked BEFORE the warehouse is resolved, not after.
  //
  // The order was the other way round, and `resolveIssueWarehouse` throws when
  // it cannot decide where stock comes from — so an invoice whose lines are all
  // SERVICES failed to post with "cannot decide where to issue stock from",
  // even though nothing was ever going to be issued. The invoice showed as sent
  // and no revenue reached the ledger. Products are read once here and reused
  // below, so this also removes a per-line lookup.
  const products = new Map<string, EntityRecord>();
  for (const l of candidates) {
    const id = String(l.productId);
    if (!products.has(id)) products.set(id, await qe.get(ctx, "product", id));
  }
  const stockLinesRaw = candidates.filter((l) => products.get(String(l.productId))?.trackStock);
  if (stockLinesRaw.length === 0) return;

  const warehouse = await resolveIssueWarehouse(ctx, inv);
  if (!warehouse) return;

  // One movement per product, and the lock order comes with it. Collapsing is
  // not a tidiness measure: `writeMovement` is idempotent on
  // (ref, refType, product, warehouse, type), so an invoice listing the same
  // product on two lines — the ordinary case of one line discounted and one not
  // — had its second line rejected as a duplicate and never issued. The invoice
  // charged for both and the shelf was only debited for one.
  //
  // `qtyBase`, not `qty`. The line may have been entered in cases; the ledger is
  // only ever in base units, because a balance that mixes cases and pieces
  // cannot be valued, picked or counted. `?? qty` covers every line written
  // before units existed, where the two are the same number.
  const stockLines = collapseMovementLines(
    stockLinesRaw.map((l) => ({
      productId: String(l.productId),
      warehouseId: String(warehouse.id),
      qtyBase: Number(l.qtyBase ?? l.qty ?? 0),
    })),
  );

  let cogsTotal = 0;
  for (const line of stockLines) {
    // No `unitCost`: an issue costs the balance's moving average. Reading
    // `product.costPrice` here is what let the Inventory account drift — goods
    // came in at the receipt cost and went out at whatever the product card
    // happened to say by then.
    const result = await inventory.writeMovement(ctx, {
      productId: line.productId,
      warehouseId: line.warehouseId,
      qty: -line.qtyBase,
      type: "issue",
      ref: String(inv.id),
      refType: "invoice",
      branchId: (inv.branchId as string) ?? null,
      movedAt: ctx.at,
    });
    // Post exactly the value the ledger removed — never a second, independent
    // computation of the same number.
    cogsTotal += -result.valueDelta;
    if (result.valueDelta === 0 && !result.duplicate) {
      logger.warn("stock issued at zero cost — no receipts recorded for this product/warehouse", {
        invoice: String(inv.number ?? inv.id),
        productId: line.productId,
        warehouseId: line.warehouseId,
      });
    }
  }
  cogsTotal = round2(cogsTotal);
  if (cogsTotal <= 0) return;

  await acc.postFromSource(ctx, {
    source: "stockIssue",
    // A cost, not a document amount: it comes from the stock balance, which
    // is already carried in the ledger's currency.
    currencyCode: BASE_CURRENCY,
    sourceRef: String(inv.id),
    date: String(inv.issueDate ?? today(ctx)),
    memo: `COGS for ${String(inv.number)}`,
    branchId: (inv.branchId as string) ?? null,
    lines: [
      { ledgerAccountId: await acc.requireAccount(ctx, "cogs"), debit: cogsTotal },
      { ledgerAccountId: await acc.requireAccount(ctx, "inventory"), credit: cogsTotal },
    ],
  });
}

/** Void a posted invoice → reverse AR/Revenue/Tax + restock issued stock and
 *  reverse COGS. Idempotent via distinct void source refs, so re-voiding is a
 *  no-op. Keeps the GL + AR sub-ledger + stock ledger consistent on cancellation. */
export async function reverseInvoiceGL(ctx: RequestContext, invoiceId: string): Promise<void> {
  const qe = await getQueryEngine();
  const acc = await getAccountingService();
  const inventory = await getInventoryService();
  const inv = await qe.get(ctx, "invoice", invoiceId);
  const total = round2(Number(inv.total ?? 0));
  // Only reverse if the invoice was actually posted to the GL.
  const postedAr = await qe.list(ctx, "journalEntry", {
    filters: [
      { field: "source", op: "eq", value: "invoice" },
      { field: "sourceRef", op: "eq", value: invoiceId },
      { field: "status", op: "eq", value: "posted" },
    ],
    pageSize: 1,
  });
  if (total <= 0 || postedAr.total === 0) return;
  const subtotal = round2(Number(inv.subtotal ?? 0));
  const tax = round2(Number(inv.taxTotal ?? 0));

  await qe.runInTransaction(async () => {
    const arLines: JournalLineInput[] = [
      { ledgerAccountId: await acc.requireAccount(ctx, "sales_revenue"), debit: subtotal },
      { ledgerAccountId: await acc.requireAccount(ctx, "accounts_receivable"), credit: total },
    ];
    // Reverse what was actually posted — the collectible share, not the full VAT.
    const collectibleTax = round2(tax - round2(Number(inv.tevkifatTotal ?? 0)));
    if (collectibleTax > 0) {
      arLines.splice(1, 0, { ledgerAccountId: await acc.requireAccount(ctx, "tax_payable"), debit: collectibleTax });
    }
    await acc.postFromSource(ctx, {
      source: "invoiceVoid",
      currencyCode: String(inv.currencyCode ?? BASE_CURRENCY),
      sourceRef: invoiceId,
      date: today(ctx),
      memo: `Void invoice ${String(inv.number)}`,
      branchId: (inv.branchId as string) ?? null,
      lines: arLines,
    });

    // Restock issued goods (receipt) + reverse COGS (Dr Inventory, Cr COGS).
    //
    // Reverse the ORIGINAL movements rather than re-deriving a cost: read what
    // each issue actually removed and put exactly that back. Re-reading
    // `product.costPrice` here (as this used to) meant a void after any price
    // change left the Inventory account permanently off by the difference.
    const issued = await qe.listComplete(ctx, "stockMovement", {
      filters: [
        { field: "ref", op: "eq", value: String(inv.id) },
        { field: "refType", op: "eq", value: "invoice" },
        { field: "type", op: "eq", value: "issue" },
      ],
    });
    let cogsTotal = 0;
    for (const mv of issued) {
      const qty = Math.abs(Number(mv.qty ?? 0));
      if (qty <= 0) continue;
      const removedValue = Math.abs(Number(mv.value ?? 0));
      const result = await inventory.writeMovement(ctx, {
        productId: String(mv.productId),
        warehouseId: String(mv.warehouseId),
        qty,
        type: "receipt",
        // Put back the same value that left, so the void nets to exactly zero.
        unitCost: qty > 0 ? round2(removedValue / qty) : 0,
        ref: `${String(inv.id)}:void`,
        refType: "invoice",
        branchId: (inv.branchId as string) ?? null,
        movedAt: ctx.at,
      });
      // Credit COGS with what the balance actually received, not with
      // `removedValue`. Rounding the per-unit cost above means the two differ by
      // cents, and posting the un-applied figure would leave the Inventory
      // account carrying a residual after the stock had returned to zero.
      cogsTotal += result.valueDelta;
    }
    cogsTotal = round2(cogsTotal);
    if (cogsTotal > 0) {
      await acc.postFromSource(ctx, {
        source: "stockIssueVoid",
    // A cost, not a document amount: it comes from the stock balance, which
    // is already carried in the ledger's currency.
    currencyCode: BASE_CURRENCY,
        sourceRef: String(inv.id),
        date: today(ctx),
        memo: `Void COGS for ${String(inv.number)}`,
        branchId: (inv.branchId as string) ?? null,
        lines: [
          { ledgerAccountId: await acc.requireAccount(ctx, "inventory"), debit: cogsTotal },
          { ledgerAccountId: await acc.requireAccount(ctx, "cogs"), credit: cogsTotal },
        ],
      });
    }
  });
}

/**
 * Post a sales return: restock at COST and reverse the sale in the GL.
 *
 * Two defects lived here before, both in the same few lines:
 *
 *  1. Goods came back in at `unitPrice` — the *selling* price — so every return
 *     inflated inventory by the gross margin on it.
 *  2. There was no GL entry at all. Revenue, tax and AR stayed as if the sale
 *     had happened, while stock said otherwise; the ledgers diverged on every
 *     return.
 *
 * Restocking cost comes from the original issue when the return references an
 * invoice (pro-rated by returned ÷ issued quantity, so a partial return brings
 * back its proportional share), and otherwise from the destination balance's
 * current average.
 *
 * Two idempotent entries are written, matching the shape `postInvoiceGL` uses:
 *   `salesReturn` → Dr Revenue + Dr Tax / Cr AR   (undo the sale)
 *   `stockReturn` → Dr Inventory / Cr COGS        (undo the cost of it)
 */
export async function postSalesReturnGL(ctx: RequestContext, returnId: string): Promise<void> {
  const qe = await getQueryEngine();
  const acc = await getAccountingService();
  const inventory = await getInventoryService();

  const doc = await qe.get(ctx, "salesReturn", returnId);
  const warehouseId = doc.warehouseId ? String(doc.warehouseId) : "";
  if (!warehouseId) throw new AccountingError("a warehouse is required to restock a return");
  const branchId = (doc.branchId as string) ?? null;
  const lines = await qe.listComplete(ctx, "salesReturnLine", {
    filters: [{ field: "salesReturnId", op: "eq", value: returnId }],
  });

  // What the original invoice issued, so a return can come back at the cost it
  // left at rather than at a price.
  const issuedByProduct = new Map<string, { qty: number; value: number }>();
  if (doc.invoiceId) {
    const issued = await qe.listComplete(ctx, "stockMovement", {
      filters: [
        { field: "ref", op: "eq", value: String(doc.invoiceId) },
        { field: "refType", op: "eq", value: "invoice" },
        { field: "type", op: "eq", value: "issue" },
      ],
    });
    for (const mv of issued) {
      const key = String(mv.productId);
      const prior = issuedByProduct.get(key) ?? { qty: 0, value: 0 };
      issuedByProduct.set(key, {
        qty: prior.qty + Math.abs(Number(mv.qty ?? 0)),
        value: prior.value + Math.abs(Number(mv.value ?? 0)),
      });
    }
  }

  // Collapsed per product, as on the way out: the same item can be returned on
  // two lines (two damaged units and three unwanted ones), and `writeMovement`
  // would treat the second as a duplicate of the first and put nothing back.
  //
  // Quantities only — the cost is attached afterwards. Folding it into the
  // weighting here would turn "no original issue found, use the balance
  // average" into a cost of zero, which is a different and much worse answer.
  //
  // Base units, as everywhere the ledger is touched — a return of one case is
  // twelve pieces back on the shelf.
  const ordered = collapseMovementLines(
    lines
      .filter((l) => l.productId && Number(l.qty ?? 0) > 0)
      .map((l) => ({
        productId: String(l.productId),
        warehouseId,
        qtyBase: Number(l.qtyBase ?? l.qty ?? 0),
      })),
  );

  let restockValue = 0;
  for (const line of ordered) {
    const origin = issuedByProduct.get(line.productId);
    // Pro-rate the original cost; fall back to the balance average (writeMovement
    // uses it when no unitCost is supplied).
    const unitCost = origin && origin.qty > 0 ? round2(origin.value / origin.qty) : undefined;
    const result = await inventory.writeMovement(ctx, {
      productId: line.productId,
      warehouseId,
      qty: line.qtyBase,
      type: "receipt",
      ...(unitCost !== undefined ? { unitCost } : {}),
      ref: returnId,
      refType: "salesReturn",
      branchId,
      movedAt: ctx.at,
    });
    restockValue += result.valueDelta;
  }
  restockValue = round2(restockValue);

  // Reverse the sale: Dr Revenue + Dr Tax, Cr AR.
  const total = round2(Number(doc.total ?? 0));
  const subtotal = round2(Number(doc.subtotal ?? 0));
  const tax = round2(Number(doc.taxTotal ?? 0));
  if (total > 0) {
    const arLines: JournalLineInput[] = [
      { ledgerAccountId: await acc.requireAccount(ctx, "sales_revenue"), debit: subtotal },
      { ledgerAccountId: await acc.requireAccount(ctx, "accounts_receivable"), credit: total },
    ];
    if (tax > 0) arLines.splice(1, 0, { ledgerAccountId: await acc.requireAccount(ctx, "tax_payable"), debit: tax });
    await acc.postFromSource(ctx, {
      source: "salesReturn",
      currencyCode: String(doc.currencyCode ?? BASE_CURRENCY),
      sourceRef: returnId,
      date: String(doc.returnDate ?? today(ctx)),
      memo: `Sales return ${String(doc.number ?? returnId)}`,
      branchId,
      lines: arLines,
    });
  }

  // Reverse the cost of it: Dr Inventory, Cr COGS.
  if (restockValue > 0) {
    await acc.postFromSource(ctx, {
      source: "stockReturn",
      currencyCode: BASE_CURRENCY,
      sourceRef: returnId,
      date: String(doc.returnDate ?? today(ctx)),
      memo: `Restock for return ${String(doc.number ?? returnId)}`,
      branchId,
      lines: [
        { ledgerAccountId: await acc.requireAccount(ctx, "inventory"), debit: restockValue },
        { ledgerAccountId: await acc.requireAccount(ctx, "cogs"), credit: restockValue },
      ],
    });
  }
}

/** Customer payment → Dr Cash/Bank, Cr AR. */
/**
 * The rate a document's receivable was actually booked at.
 *
 * Read back off the journal line rather than recomputed from the document's
 * date, because the line IS the record of what went into the ledger. A rate
 * corrected after posting must not silently change what a receivable is carried
 * at — the entry that created it is the fact, and clearing it at anything else
 * would leave a balance behind with nothing to explain it.
 *
 * Returns null when the document was posted in the base currency, or when no
 * posting is found (nothing to reconcile against).
 */
async function bookedRateFor(ctx: RequestContext, source: string, sourceRef: string): Promise<number | null> {
  const qe = await getQueryEngine();
  const entries = await qe.list(ctx, "journalEntry", {
    filters: [
      { field: "source", op: "eq", value: source },
      { field: "sourceRef", op: "eq", value: sourceRef },
      { field: "status", op: "eq", value: "posted" },
    ],
    pageSize: 1,
  });
  const entry = entries.items[0];
  if (!entry) return null;
  const lines = await qe.listComplete(ctx, "journalLine", {
    filters: [{ field: "entryId", op: "eq", value: String(entry.id) }],
  });
  const withRate = lines.find((l) => Number(l.exchangeRate ?? 0) > 0);
  return withRate ? Number(withRate.exchangeRate) : null;
}

/**
 * Customer payment → Dr cash/bank/cheque, Cr Receivables.
 *
 * In one currency this is two equal legs. In two it is not, and that is the
 * whole difficulty: the receivable carries what it was booked at, while the
 * money arriving is worth what it is worth TODAY. An invoice for €1,000 raised
 * at 47.0 put 47,000 into receivables; paid when the rate is 48.0 the bank
 * receives 48,000. Clearing the receivable at 48,000 would leave 1,000 of
 * receivable that was never owed; clearing the bank at 47,000 would understate
 * what actually arrived. Both legs are right, and the difference is a realised
 * FX gain or loss (646 / 656) — not revenue, and not a rounding error.
 *
 * The legs are computed in the ledger's currency here rather than handed to the
 * uniform conversion in `postFromSource`, precisely because they need TWO rates.
 */
export async function postPaymentGL(ctx: RequestContext, payment: EntityRecord): Promise<void> {
  const acc = await getAccountingService();
  const qe = await getQueryEngine();
  const amount = round2(Number(payment.amount ?? 0));
  if (amount <= 0) return;

  const invoice = payment.invoiceId ? await qe.get(ctx, "invoice", String(payment.invoiceId)).catch(() => null) : null;
  const currency = String(invoice?.currencyCode ?? BASE_CURRENCY);
  const paidAt = String(payment.paidAt ?? today(ctx));
  const settlementAccount = await acc.requireAccount(ctx, inboundSettlementSubtype(String(payment.method ?? "bank")));
  const receivable = await acc.requireAccount(ctx, "accounts_receivable");

  const { isBase } = await import("@/lib/finance/fx");

  if (isBase(currency)) {
    await acc.postFromSource(ctx, {
      source: "payment",
      currencyCode: BASE_CURRENCY,
      sourceRef: String(payment.id),
      date: paidAt,
      memo: `Payment ${String(payment.number)}`,
      branchId: (payment.branchId as string) ?? null,
      lines: [
        // Where the money actually went: the till, the bank, or a cheque we now
        // hold. Everything used to debit the bank account regardless of method.
        { ledgerAccountId: settlementAccount, debit: amount },
        { ledgerAccountId: receivable, credit: amount },
      ],
    });
    return;
  }

  const { lines, paymentRate } = await foreignSettlementLines(ctx, {
    amount,
    currency,
    paidAt,
    source: "invoice",
    sourceRef: String(invoice?.id ?? ""),
    balanceAccount: receivable,
    settlementAccount,
    direction: "in",
  });

  await acc.postFromSource(ctx, {
    source: "payment",
    // Already expressed in the ledger's currency — the two rates have been
    // applied above, and a uniform conversion here would apply a third.
    currencyCode: BASE_CURRENCY,
    sourceRef: String(payment.id),
    date: paidAt,
    memo: `Payment ${String(payment.number)} (${currency} @ ${paymentRate})`,
    branchId: (payment.branchId as string) ?? null,
    lines,
  });
}

/**
 * Goods receipt → Dr Inventory, Cr GR/IR clearing.
 *
 * Takes the results of the stock movements rather than the line inputs, so the
 * amount debited to Inventory is by construction the amount the stock ledger
 * added. Recomputing `qty × unitCost` here was a second, independent derivation
 * of the same figure — two places to drift apart.
 */
export async function postGoodsReceiptGL(
  ctx: RequestContext,
  grn: EntityRecord,
  movements: { valueDelta: number }[],
): Promise<void> {
  const acc = await getAccountingService();
  let total = 0;
  for (const m of movements) total += m.valueDelta;
  total = round2(total);
  if (total <= 0) return;
  await acc.postFromSource(ctx, {
    source: "goodsReceipt",
      currencyCode: String(grn.currencyCode ?? BASE_CURRENCY),
    sourceRef: String(grn.id),
    date: String(grn.receiptDate ?? today(ctx)),
    memo: `GRN ${String(grn.number)}`,
    branchId: (grn.branchId as string) ?? null,
    lines: [
      { ledgerAccountId: await acc.requireAccount(ctx, "inventory"), debit: total },
      { ledgerAccountId: await acc.requireAccount(ctx, "gr_ir"), credit: total },
    ],
  });
}

/** Vendor bill received → Dr GR/IR (or Expense) + Tax, Cr Accounts Payable.
 *  3-way match: when linked to a GRN, GR/IR is cleared for the *receipt* value and
 *  any difference vs the billed subtotal is posted to Purchase Price Variance, so
 *  GR/IR nets to zero instead of carrying a hidden balance. */
export async function postVendorBillGL(ctx: RequestContext, bill: EntityRecord): Promise<void> {
  const qe = await getQueryEngine();
  const acc = await getAccountingService();
  const total = round2(Number(bill.total ?? 0));
  if (total <= 0) return;
  const subtotal = round2(Number(bill.subtotal ?? 0));
  const tax = round2(Number(bill.taxTotal ?? 0));
  const lines: JournalLineInput[] = [];

  if (bill.goodsReceiptId) {
    // Clear GR/IR at the value the goods receipt credited it with…
    const grnLines = await qe.listComplete(ctx, "goodsReceiptLine", { filters: [{ field: "grnId", op: "eq", value: bill.goodsReceiptId }] });
    const grnValue = round2(grnLines.reduce((s, l) => s + Number(l.qty ?? 0) * Number(l.unitCost ?? 0), 0));
    lines.push({ ledgerAccountId: await acc.requireAccount(ctx, "gr_ir"), debit: grnValue });
    // …and book the receipt-vs-bill difference as a purchase price variance.
    const variance = round2(subtotal - grnValue);
    if (Math.abs(variance) >= 0.005) {
      const ppv = await acc.requireAccount(ctx, "purchase_price_variance");
      lines.push(variance > 0 ? { ledgerAccountId: ppv, debit: variance } : { ledgerAccountId: ppv, credit: -variance });
    }
    // Recorded on the bill as well as posted to the ledger. It used to exist
    // only as a journal line, so "which bills came in over the receipt price?"
    // — the question a buyer actually asks — could only be answered by reading
    // the ledger back and inferring which document each line came from. Written
    // even when it is zero, so a matched bill is distinguishable from one that
    // was never matched at all (null).
    await qe.patchComputed(ctx, "vendorBill", String(bill.id), { priceVariance: variance });
  } else {
    // No GRN linked → straight expense.
    lines.push({ ledgerAccountId: await acc.requireAccount(ctx, "operating_expense"), debit: subtotal });
  }

  lines.push({ ledgerAccountId: await acc.requireAccount(ctx, "accounts_payable"), credit: total });
  // Purchase VAT is INPUT VAT — 191 İndirilecek KDV, an asset — not a debit
  // against 391 Hesaplanan KDV. The net owed is the same either way, which is
  // why this went unnoticed, but the KDV beyannamesi reports the two separately
  // and a liability account carrying a debit balance means nothing to anyone
  // reading the mizan.
  if (tax > 0) lines.push({ ledgerAccountId: await acc.requireAccount(ctx, "vat_deductible"), debit: tax });
  await acc.postFromSource(ctx, {
    source: "vendorBill",
      currencyCode: String(bill.currencyCode ?? BASE_CURRENCY),
    sourceRef: String(bill.id),
    date: String(bill.billDate ?? today(ctx)),
    memo: `Vendor bill ${String(bill.number)}`,
    branchId: (bill.branchId as string) ?? null,
    lines,
  });
}

/** Bill payment → Dr Accounts Payable, Cr Cash/Bank. */
/**
 * Supplier payment → Dr Payables, Cr cash/bank/cheque.
 *
 * The mirror of a customer receipt, and it needed the same two-rate treatment
 * for the same reason: the payable carries what the bill was booked at, while
 * the money leaving is worth today's rate. The difference in SIGN is the part
 * worth stating — when the currency strengthens a receipt gains and a payment
 * LOSES, because more has to go out than the payable carried. Sharing the
 * arithmetic is how those two stay opposite on purpose rather than by accident.
 */
export async function postBillPaymentGL(ctx: RequestContext, payment: EntityRecord): Promise<void> {
  const acc = await getAccountingService();
  const qe = await getQueryEngine();
  const amount = round2(Number(payment.amount ?? 0));
  if (amount <= 0) return;

  const bill = payment.vendorBillId
    ? await qe.get(ctx, "vendorBill", String(payment.vendorBillId)).catch(() => null)
    : null;
  const currency = String(bill?.currencyCode ?? BASE_CURRENCY);
  const paidAt = String(payment.paidAt ?? today(ctx));
  const payable = await acc.requireAccount(ctx, "accounts_payable");
  // Paid from the till, the bank, or by issuing our own cheque.
  const settlementAccount = await acc.requireAccount(ctx, outboundSettlementSubtype(String(payment.method ?? "bank")));

  const { isBase } = await import("@/lib/finance/fx");

  if (isBase(currency)) {
    await acc.postFromSource(ctx, {
      source: "billPayment",
      currencyCode: BASE_CURRENCY,
      sourceRef: String(payment.id),
      date: paidAt,
      memo: `Bill payment ${String(payment.number)}`,
      branchId: (payment.branchId as string) ?? null,
      lines: [
        { ledgerAccountId: payable, debit: amount },
        { ledgerAccountId: settlementAccount, credit: amount },
      ],
    });
    return;
  }

  const { lines, paymentRate } = await foreignSettlementLines(ctx, {
    amount,
    currency,
    paidAt,
    source: "vendorBill",
    sourceRef: String(bill?.id ?? ""),
    balanceAccount: payable,
    settlementAccount,
    direction: "out",
  });

  await acc.postFromSource(ctx, {
    source: "billPayment",
    // Already in the ledger's currency — the two rates were applied above, and a
    // uniform conversion here would apply a third.
    currencyCode: BASE_CURRENCY,
    sourceRef: String(payment.id),
    date: paidAt,
    memo: `Bill payment ${String(payment.number)} (${currency} @ ${paymentRate})`,
    branchId: (payment.branchId as string) ?? null,
    lines,
  });
}

/**
 * The two legs of settling a balance that was booked in another currency.
 *
 * Shared by customer receipts and supplier payments because the shape is
 * identical and the risk of two copies is precisely the asymmetry this fixes:
 * one side handling FX and the other quietly not.
 *
 * `settlementSide` says which way the money moves. For a receipt the money
 * ARRIVES, so a strengthening currency means more came in than the receivable
 * carried — a gain. For a payment the money LEAVES, so the same movement means
 * more went out than the payable carried — a loss. Same arithmetic, opposite
 * meaning, and getting it backwards books a loss as a gain.
 */
async function foreignSettlementLines(
  ctx: RequestContext,
  opts: {
    amount: number;
    currency: string;
    paidAt: string;
    /** The document whose balance is being cleared. */
    source: string;
    sourceRef: string;
    /** The account carrying the balance (receivable or payable). */
    balanceAccount: string;
    /** Where the money moves to or from. */
    settlementAccount: string;
    /** `in` — a receipt; `out` — a payment. */
    direction: "in" | "out";
  },
): Promise<{ lines: JournalLineInput[]; paymentRate: number }> {
  const acc = await getAccountingService();
  const { rateFor, realisedFx } = await import("@/lib/finance/fx");

  const paymentRate = await rateFor(ctx, opts.currency, opts.paidAt);
  // Falls back to the payment rate when the document carries no recorded rate —
  // it predates this mechanism. That yields a zero difference, i.e. exactly the
  // old behaviour, rather than one invented from a rate never used.
  const bookedRate = (await bookedRateFor(ctx, opts.source, opts.sourceRef)) ?? paymentRate;

  const settled = round2(opts.amount * paymentRate);
  const clearing = round2(opts.amount * bookedRate);
  const difference = realisedFx(opts.amount, bookedRate, paymentRate);

  const trail = { documentCurrency: opts.currency, documentAmount: opts.amount };
  const lines: JournalLineInput[] =
    opts.direction === "in"
      ? [
          { ledgerAccountId: opts.settlementAccount, debit: settled, ...trail, exchangeRate: paymentRate },
          { ledgerAccountId: opts.balanceAccount, credit: clearing, ...trail, exchangeRate: bookedRate },
        ]
      : [
          { ledgerAccountId: opts.balanceAccount, debit: clearing, ...trail, exchangeRate: bookedRate },
          { ledgerAccountId: opts.settlementAccount, credit: settled, ...trail, exchangeRate: paymentRate },
        ];

  // A receipt gains when the currency strengthens; a payment loses.
  const isGain = opts.direction === "in" ? difference > 0 : difference < 0;
  const magnitude = Math.abs(difference);
  if (magnitude > 0) {
    lines.push(
      isGain
        ? { ledgerAccountId: await acc.requireAccount(ctx, "fx_gain"), credit: magnitude, description: "Kambiyo kârı" }
        : { ledgerAccountId: await acc.requireAccount(ctx, "fx_loss"), debit: magnitude, description: "Kambiyo zararı" },
    );
  }
  return { lines, paymentRate };
}

/** Write the paired transfer_out / transfer_in movements for a transfer record
 *  (idempotent via the ledger; net-zero on total on-hand). No status change. */
async function applyTransferMovements(ctx: RequestContext, t: EntityRecord): Promise<void> {
  const qty = Number(t.qty ?? 0);
  if (qty <= 0) return;
  const qe = await getQueryEngine();
  const inventory = await getInventoryService();
  const branchId = (t.branchId as string) ?? null;

  // Out first, at the source balance's average — then in at exactly the cost
  // that left. Value is net-zero by construction. The hand-keyed `unitCost` this
  // used to take could move value between warehouses out of nowhere.
  const out = await inventory.writeMovement(ctx, {
    productId: String(t.productId), warehouseId: String(t.fromWarehouseId), qty: -qty,
    type: "transfer_out", ref: String(t.id), refType: "stockTransfer", branchId, movedAt: ctx.at,
  });
  const unitCost = qty > 0 ? round2(Math.abs(out.valueDelta) / qty) : 0;
  await inventory.writeMovement(ctx, {
    productId: String(t.productId), warehouseId: String(t.toWarehouseId), qty,
    type: "transfer_in", unitCost, ref: String(t.id), refType: "stockTransfer", branchId, movedAt: ctx.at,
  });
  // Record the derived cost on the document so the screen shows what was moved.
  if (!out.duplicate) await qe.patchComputed(ctx, "stockTransfer", String(t.id), { unitCost });
}

/**
 * The warehouse that holds goods between dispatch and receipt.
 *
 * A real balance row rather than "nowhere", because `SUM(stockBalance.value)`
 * has to keep equalling the Inventory account. Goods moving between two of the
 * company's own warehouses never leave the company — nothing is sold, nothing is
 * bought — so the GL is untouched and this is purely a question of which
 * location holds the stock. Letting the value vanish for two days would break
 * that equality and the nightly reconcile would report drift that is not drift.
 *
 * Provisioned on first use. A deployment that never transfers anything never
 * grows the row.
 */
const TRANSIT_WAREHOUSE_CODE = "IN-TRANSIT";

async function transitWarehouseId(ctx: RequestContext): Promise<string> {
  const qe = await getQueryEngine();
  const existing = await qe.list(ctx, "warehouse", {
    filters: [{ field: "code", op: "eq", value: TRANSIT_WAREHOUSE_CODE }],
    pageSize: 1,
  });
  if (existing.items[0]) return String(existing.items[0].id);
  const created = await qe.create(ctx, "warehouse", {
    name: "In Transit",
    code: TRANSIT_WAREHOUSE_CODE,
    // Not a place anyone picks from — it is an accounting location that happens
    // to be modelled as a warehouse.
    active: true,
  });
  logger.info("provisioned the in-transit warehouse", { warehouseId: String(created.id) });
  return String(created.id);
}

/**
 * Dispatch: stock leaves the source and moves into transit.
 *
 * Costed at the source balance's average and received into transit at exactly
 * the value that left, so the move is value-neutral by construction — the same
 * property the single-step transfer relies on, applied to each leg.
 */
async function dispatchTransfer(ctx: RequestContext, t: EntityRecord): Promise<void> {
  const qty = Number(t.qty ?? 0);
  if (qty <= 0) return;
  const qe = await getQueryEngine();
  const inventory = await getInventoryService();
  const branchId = (t.branchId as string) ?? null;
  const transitId = await transitWarehouseId(ctx);

  const out = await inventory.writeMovement(ctx, {
    productId: String(t.productId), warehouseId: String(t.fromWarehouseId), qty: -qty,
    type: "transfer_out", ref: String(t.id), refType: "stockTransfer", branchId, movedAt: ctx.at,
  });
  const unitCost = qty > 0 ? round2(Math.abs(out.valueDelta) / qty) : 0;
  await inventory.writeMovement(ctx, {
    productId: String(t.productId), warehouseId: transitId, qty,
    type: "transfer_in", unitCost, ref: `${String(t.id)}:transit`, refType: "stockTransfer", branchId, movedAt: ctx.at,
  });
  if (!out.duplicate) {
    await qe.patchComputed(ctx, "stockTransfer", String(t.id), { unitCost, dispatchedAt: ctx.at });
  }
}

/**
 * Receive: stock leaves transit and arrives at the destination.
 *
 * Costed from the transit balance rather than from the document's recorded
 * `unitCost`: if two transfers of the same product are in flight at once they
 * share a transit balance, and consuming the average is the only figure that
 * keeps that balance able to reach exactly zero.
 */
async function receiveTransfer(ctx: RequestContext, t: EntityRecord): Promise<void> {
  const qty = Number(t.qty ?? 0);
  if (qty <= 0) return;
  const qe = await getQueryEngine();
  const inventory = await getInventoryService();
  const branchId = (t.branchId as string) ?? null;
  const transitId = await transitWarehouseId(ctx);

  const out = await inventory.writeMovement(ctx, {
    productId: String(t.productId), warehouseId: transitId, qty: -qty,
    type: "transfer_out", ref: `${String(t.id)}:transit-out`, refType: "stockTransfer", branchId, movedAt: ctx.at,
  });
  const unitCost = qty > 0 ? round2(Math.abs(out.valueDelta) / qty) : 0;
  await inventory.writeMovement(ctx, {
    productId: String(t.productId), warehouseId: String(t.toWarehouseId), qty,
    type: "transfer_in", unitCost, ref: String(t.id), refType: "stockTransfer", branchId, movedAt: ctx.at,
  });
  if (!out.duplicate) await qe.patchComputed(ctx, "stockTransfer", String(t.id), { receivedAt: ctx.at });
}

/** Reverse a posted transfer's movements (idempotent via a distinct `:void` ref
 *  so re-voiding is a no-op and the reversal never collides with the forward keys). */
async function reverseTransferMovements(ctx: RequestContext, t: EntityRecord): Promise<void> {
  const qty = Number(t.qty ?? 0);
  if (qty <= 0) return;
  const inventory = await getInventoryService();
  const branchId = (t.branchId as string) ?? null;
  const ref = `${String(t.id)}:void`;
  // Mirror of the forward move: out of the destination at ITS average, back into
  // the source at the cost that left. Using the document's stored `unitCost`
  // would inject a value the destination balance may no longer hold.
  const out = await inventory.writeMovement(ctx, {
    productId: String(t.productId), warehouseId: String(t.toWarehouseId), qty: -qty,
    type: "transfer_out", ref, refType: "stockTransfer", branchId, movedAt: ctx.at,
  });
  await inventory.writeMovement(ctx, {
    productId: String(t.productId), warehouseId: String(t.fromWarehouseId), qty,
    type: "transfer_in", unitCost: qty > 0 ? round2(Math.abs(out.valueDelta) / qty) : 0,
    ref, refType: "stockTransfer", branchId, movedAt: ctx.at,
  });
}

/** Post a stock transfer (paired movements, no GL) and flag it posted. Used by the
 *  dedicated `/stock-transfers/:id/post` endpoint + smoke; the `stockTransfer.post`
 *  lifecycle transition runs the same movements via registerAccountingPostings. */
export async function postStockTransfer(ctx: RequestContext, transferId: string): Promise<EntityRecord> {
  const qe = await getQueryEngine();
  const t = await qe.get(ctx, "stockTransfer", transferId);
  if (t.status === "posted") return t;
  await applyTransferMovements(ctx, t);
  return qe.patchComputed(ctx, "stockTransfer", transferId, { status: "posted" });
}

/** Write the signed movement + GL entry for an adjustment (idempotent). No status change. */
async function applyAdjustmentPosting(ctx: RequestContext, a: EntityRecord): Promise<void> {
  const delta = Number(a.qtyDelta ?? 0);
  if (delta === 0) return;
  const inventory = await getInventoryService();
  const acc = await getAccountingService();
  const branchId = (a.branchId as string) ?? null;
  // Write-on (delta > 0) takes the entered cost, defaulting to the current
  // average. Write-off (delta < 0) IGNORES any entered cost: value removed must
  // be value that was actually there, or the account and the stock diverge.
  const result = await inventory.writeMovement(ctx, {
    productId: String(a.productId),
    warehouseId: String(a.warehouseId),
    qty: delta,
    type: "adjustment",
    ...(delta > 0 && a.unitCost != null ? { unitCost: round2(Number(a.unitCost)) } : {}),
    ref: String(a.id),
    refType: "adjustment",
    branchId,
    movedAt: ctx.at,
  });
  const value = round2(Math.abs(result.valueDelta));
  if (value > 0) {
    const invAcc = await acc.requireAccount(ctx, "inventory");
    // A dedicated account. The old `accountBySubtype("operating_expense") ?? invAcc`
    // fallback silently produced an Inventory-to-Inventory entry — balanced,
    // posted, and with no effect on anything.
    const adjustExpenseAcc = await acc.requireAccount(ctx, "inventory_adjustment");
    const lines: JournalLineInput[] = delta > 0
      ? [{ ledgerAccountId: invAcc, debit: value }, { ledgerAccountId: adjustExpenseAcc, credit: value }]
      : [{ ledgerAccountId: adjustExpenseAcc, debit: value }, { ledgerAccountId: invAcc, credit: value }];
    await acc.postFromSource(ctx, { source: "adjustment", currencyCode: BASE_CURRENCY, sourceRef: String(a.id), date: String(a.adjustedAt ?? today(ctx)), memo: `Adjustment ${String(a.number)}`, branchId, lines });
  }
}

/** Reverse a posted adjustment: opposite movement + reversing GL, keyed on a
 *  distinct `:void` ref so re-voiding is idempotent. */
async function reverseAdjustmentPosting(ctx: RequestContext, a: EntityRecord): Promise<void> {
  const delta = Number(a.qtyDelta ?? 0);
  if (delta === 0) return;
  const qe = await getQueryEngine();
  const inventory = await getInventoryService();
  const acc = await getAccountingService();
  const branchId = (a.branchId as string) ?? null;
  const ref = `${String(a.id)}:void`;
  // Reverse what the original movement actually did, read from the ledger,
  // rather than re-deriving it from the document's `unitCost`.
  const [original] = await qe.listComplete(ctx, "stockMovement", {
    filters: [
      { field: "ref", op: "eq", value: String(a.id) },
      { field: "refType", op: "eq", value: "adjustment" },
      { field: "type", op: "eq", value: "adjustment" },
    ],
  });
  if (!original) return; // never posted — nothing to reverse
  const originalValue = Math.abs(Number(original.value ?? 0));
  const result = await inventory.writeMovement(ctx, {
    productId: String(a.productId),
    warehouseId: String(a.warehouseId),
    qty: -delta,
    type: "adjustment",
    // Reversing a write-off puts stock back: it must return the value that left.
    ...(delta < 0 ? { unitCost: round2(originalValue / Math.abs(delta)) } : {}),
    ref,
    refType: "adjustment",
    branchId,
    movedAt: ctx.at,
  });
  // Post what the balance actually moved, not the original figure: rounding the
  // per-unit cost above makes them differ by cents, and the account would keep
  // the difference forever.
  const value = round2(Math.abs(result.valueDelta));
  if (value > 0) {
    const invAcc = await acc.requireAccount(ctx, "inventory");
    const adjustExpenseAcc = await acc.requireAccount(ctx, "inventory_adjustment");
    const lines: JournalLineInput[] = delta > 0
      ? [{ ledgerAccountId: adjustExpenseAcc, debit: value }, { ledgerAccountId: invAcc, credit: value }]
      : [{ ledgerAccountId: invAcc, debit: value }, { ledgerAccountId: adjustExpenseAcc, credit: value }];
    await acc.postFromSource(ctx, { source: "adjustment", currencyCode: BASE_CURRENCY, sourceRef: ref, date: String(a.adjustedAt ?? today(ctx)), memo: `Void adjustment ${String(a.number)}`, branchId, lines });
  }
}

/** Post a stock adjustment (movement + GL) and flag it posted. Used by the
 *  dedicated `/stock-adjustments/:id/post` endpoint + smoke; the
 *  `stockAdjustment.post` transition runs the same posting via registerAccountingPostings. */
export async function postStockAdjustment(ctx: RequestContext, adjId: string): Promise<EntityRecord> {
  const qe = await getQueryEngine();
  const a = await qe.get(ctx, "stockAdjustment", adjId);
  if (a.status === "posted") return a;
  await applyAdjustmentPosting(ctx, a);
  return qe.patchComputed(ctx, "stockAdjustment", adjId, { status: "posted" });
}

/**
 * Reverse a posted goods receipt: take the stock back out and clear the GL.
 *
 * `goodsReceipt` declares a post→void transition but had no handler, so voiding
 * one flipped the status and left the stock and the Inventory/GR-IR entries
 * exactly where they were.
 *
 * The removal is costed at the balance's current average rather than the GRN's
 * price: once other receipts have blended into the average, taking out the
 * original price would remove value the balance no longer carries.
 */
async function reverseGoodsReceipt(ctx: RequestContext, grnId: string): Promise<void> {
  const qe = await getQueryEngine();
  const acc = await getAccountingService();
  const inventory = await getInventoryService();
  const grn = await qe.get(ctx, "goodsReceipt", grnId);

  const received = await qe.listComplete(ctx, "stockMovement", {
    filters: [
      { field: "ref", op: "eq", value: grnId },
      { field: "refType", op: "eq", value: "goodsReceipt" },
      { field: "type", op: "eq", value: "receipt" },
    ],
  });
  if (received.length === 0) return; // never posted — nothing to reverse

  const branchId = (grn.branchId as string) ?? null;
  let total = 0;
  for (const mv of [...received].sort((a, b) => String(a.productId).localeCompare(String(b.productId)))) {
    const qty = Math.abs(Number(mv.qty ?? 0));
    if (qty <= 0) continue;
    const result = await inventory.writeMovement(ctx, {
      productId: String(mv.productId),
      warehouseId: String(mv.warehouseId),
      qty: -qty,
      type: "issue",
      ref: `${grnId}:void`,
      refType: "goodsReceipt",
      branchId,
      movedAt: ctx.at,
    });
    total += -result.valueDelta;
  }
  total = round2(total);
  if (total <= 0) return;

  await acc.postFromSource(ctx, {
    source: "goodsReceiptVoid",
      currencyCode: BASE_CURRENCY,
    sourceRef: grnId,
    date: today(ctx),
    memo: `Void GRN ${String(grn.number ?? grnId)}`,
    branchId,
    lines: [
      { ledgerAccountId: await acc.requireAccount(ctx, "gr_ir"), debit: total },
      { ledgerAccountId: await acc.requireAccount(ctx, "inventory"), credit: total },
    ],
  });
}

/**
 * Dispatch a delivery note: goods leave, and their cost leaves Inventory with
 * them.
 *
 * The GL entry belongs HERE and not on the invoice, because the goods went out
 * here. An irsaliye dispatched on the 3rd and invoiced on the 30th would
 * otherwise leave four weeks in which the stock ledger says the shelf is empty
 * and the Inventory account says it is full — and the reconciliation invariant
 * (`Inventory GL == SUM(stockBalance.value)`) is exactly what that breaks.
 *
 * Revenue still lands on the invoice. Goods and money are separate events in a
 * distribution business, and this is the half that moves goods.
 */
async function postDeliveryNote(ctx: RequestContext, noteId: string): Promise<void> {
  const { applyDelivery } = await import("@/lib/sales/orders");
  const qe = await getQueryEngine();
  const acc = await getAccountingService();
  const cogsTotal = await applyDelivery(ctx, noteId);
  if (cogsTotal <= 0) return;
  const note = await qe.get(ctx, "deliveryNote", noteId);

  await acc.postFromSource(ctx, {
    source: "stockIssue",
    // A cost, not a document amount: it comes from the stock balance, which is
    // already carried in the ledger's currency.
    currencyCode: BASE_CURRENCY,
    // The NOTE's id, so this cannot collide with the `stockIssue` entry an
    // invoice posts when it ships its own stock.
    sourceRef: noteId,
    date: String(note.dispatchedAt ?? today(ctx)).slice(0, 10),
    memo: `COGS for ${String(note.number ?? noteId)}`,
    branchId: (note.branchId as string) ?? null,
    lines: [
      { ledgerAccountId: await acc.requireAccount(ctx, "cogs"), debit: cogsTotal },
      { ledgerAccountId: await acc.requireAccount(ctx, "inventory"), credit: cogsTotal },
    ],
  });
}

/** Void a dispatched delivery note: stock back on the shelf, COGS reversed. */
async function reverseDeliveryNote(ctx: RequestContext, noteId: string): Promise<void> {
  const { voidDelivery } = await import("@/lib/sales/orders");
  const qe = await getQueryEngine();
  const acc = await getAccountingService();
  const restored = await voidDelivery(ctx, noteId);
  if (restored <= 0) return;
  const note = await qe.get(ctx, "deliveryNote", noteId);

  await acc.postFromSource(ctx, {
    source: "stockIssueVoid",
    currencyCode: BASE_CURRENCY,
    sourceRef: noteId,
    date: today(ctx),
    memo: `Void ${String(note.number ?? noteId)}`,
    branchId: (note.branchId as string) ?? null,
    lines: [
      { ledgerAccountId: await acc.requireAccount(ctx, "inventory"), debit: restored },
      { ledgerAccountId: await acc.requireAccount(ctx, "cogs"), credit: restored },
    ],
  });
}

/** The lifecycle events that produce GL entries / stock movements. */
const POSTING_EVENTS = new Set([
  "invoice.send",
  "invoice.void",
  "stockTransfer.post",
  // The two-step path: stock leaves on dispatch and arrives on receive, sitting
  // in the transit location in between.
  "stockTransfer.dispatch",
  "stockTransfer.receive",
  "stockTransfer.void",
  "stockAdjustment.post",
  "stockAdjustment.void",
  "salesReturn.post",
  /**
   * `goodsReceipt.post` reached the stock ledger only through the bespoke
   * /goods-receipts/:id/post route. Driving the same transition through the
   * generic lifecycle endpoint flipped the status and posted NOTHING — no stock
   * movement, no Inventory/GR-IR entry, and the purchase order left showing
   * nothing received. Exactly the shape of the `vendorBill.receive` gap.
   */
  "goodsReceipt.post",
  "goodsReceipt.void",
  // İrsaliye: the goods leaving is its own event, weeks before the invoice.
  "deliveryNote.post",
  "deliveryNote.void",
  // Navlun/gümrük: value added to goods that already arrived.
  "landedCost.apply",
  "landedCost.void",
  // Alım iadesi: goods going back to the supplier.
  "purchaseReturn.post",
  "purchaseReturn.void",
  // Confirming an order holds stock and cancelling gives it back. Registered
  // here so the generic lifecycle endpoint takes the same path as the bespoke
  // route — otherwise confirming through it moves the status and holds nothing.
  "salesOrder.confirm",
  "salesOrder.cancel",
  // `vendorBill.receive` posts the AP entry. It reached the GL only through the
  // bespoke /vendor-bills/:id/receive route — driving the same transition through
  // the generic lifecycle endpoint flipped the status and posted nothing, so the
  // bill was "received" with no payable and no input VAT recorded.
  "vendorBill.receive",
  // Çek/senet: what happens to the instrument after it is taken in.
  "cheque.clear",
  "cheque.bounce",
  "cheque.endorse",
]);

/** Run the (idempotent) side effect for a posting event. Shared by the live
 *  subscriber and the retry pass so both take exactly the same path. */
async function dispatchPosting(type: string, tenantId: string, orgId: string, id: string): Promise<void> {
  if (!id) return;
  const ctx = systemContext(tenantId, orgId);
  const qe = await getQueryEngine();
  switch (type) {
    case "invoice.send":
      await postInvoiceGL(ctx, id);
      break;
    case "invoice.void":
      await reverseInvoiceGL(ctx, id);
      break;
    case "stockTransfer.post":
      await applyTransferMovements(ctx, await qe.get(ctx, "stockTransfer", id));
      break;
    case "stockTransfer.dispatch":
      await dispatchTransfer(ctx, await qe.get(ctx, "stockTransfer", id));
      break;
    case "stockTransfer.receive":
      await receiveTransfer(ctx, await qe.get(ctx, "stockTransfer", id));
      break;
    case "stockTransfer.void":
      await reverseTransferMovements(ctx, await qe.get(ctx, "stockTransfer", id));
      break;
    case "stockAdjustment.post":
      await applyAdjustmentPosting(ctx, await qe.get(ctx, "stockAdjustment", id));
      break;
    case "stockAdjustment.void":
      await reverseAdjustmentPosting(ctx, await qe.get(ctx, "stockAdjustment", id));
      break;
    case "salesReturn.post":
      await postSalesReturnGL(ctx, id);
      break;
    case "goodsReceipt.post": {
      const { getPurchasingService } = await import("@/lib/purchasing/service");
      // `applyGRN`, not `postGRN`: the lifecycle has already set the status, so
      // `postGRN`'s "already posted" check would make this a no-op — which is
      // precisely how the receipt ended up posting nothing.
      await (await getPurchasingService()).applyGRN(ctx, id);
      break;
    }
    case "goodsReceipt.void":
      await reverseGoodsReceipt(ctx, id);
      break;
    case "deliveryNote.post":
      await postDeliveryNote(ctx, id);
      break;
    case "deliveryNote.void":
      await reverseDeliveryNote(ctx, id);
      break;
    case "landedCost.apply": {
      const { applyLandedCost, postLandedCostGL } = await import("@/lib/purchasing/landed-cost");
      // The ledger applies the value and reports exactly what it applied; the
      // GL posts that number rather than the document's face amount, so a
      // rounding remainder cannot separate the two.
      await postLandedCostGL(ctx, id, await applyLandedCost(ctx, id));
      break;
    }
    case "landedCost.void": {
      const { voidLandedCost, reverseLandedCostGL } = await import("@/lib/purchasing/landed-cost");
      await reverseLandedCostGL(ctx, id, await voidLandedCost(ctx, id));
      break;
    }
    case "purchaseReturn.post": {
      const { postPurchaseReturn } = await import("@/lib/purchasing/returns");
      await postPurchaseReturn(ctx, id);
      break;
    }
    case "purchaseReturn.void": {
      const { voidPurchaseReturn } = await import("@/lib/purchasing/returns");
      await voidPurchaseReturn(ctx, id);
      break;
    }
    case "salesOrder.confirm": {
      // `reserveOrderStock`, not `confirmOrder`: the lifecycle has already set
      // the status, so `confirmOrder`'s draft check would reject it — and the
      // order would sit confirmed with nothing held.
      const { reserveOrderStock } = await import("@/lib/sales/orders");
      await reserveOrderStock(ctx, id);
      break;
    }
    case "salesOrder.cancel": {
      const { releaseOrder } = await import("@/lib/sales/orders");
      await releaseOrder(ctx, id);
      break;
    }
    case "cheque.clear":
      await postChequeCleared(ctx, id);
      break;
    case "cheque.bounce":
      await postChequeBounced(ctx, id);
      break;
    case "cheque.endorse":
      await postChequeEndorsed(ctx, id);
      break;
    case "vendorBill.receive":
      // Idempotent on (source, sourceRef), so the bespoke route having already
      // posted it makes this a no-op rather than a double entry.
      await postVendorBillGL(ctx, await qe.get(ctx, "vendorBill", id));
      break;
  }
}

// ---- posting-failure tracking + retry (no more silent loss) ----------------
export interface PostingFailure {
  tenantId: string;
  orgId: string;
  type: string;
  id: string;
  attempts: number;
  lastError: string;
  firstAt: string;
  lastAt: string;
  dead: boolean;
}
const postingFailures = new Map<string, PostingFailure>();
const MAX_POSTING_ATTEMPTS = 6;
const failureKey = (t: string, o: string, type: string, id: string) => `${t}:${o}:${type}:${id}`;

/**
 * Subscribe to the lifecycle transitions that must produce GL entries / stock
 * movements. The generic transition endpoint only flips the status field and
 * emits the event — the (idempotent) side effects run here.
 *
 * A posting failure is no longer silently swallowed: it is recorded in a retry
 * queue (so it's visible and eventually re-attempted by the scheduler) rather
 * than leaving the GL/stock ledger quietly out of sync with the document.
 */
export function registerAccountingPostings(): void {
  eventBus.subscribe("*", async (event: DomainEvent) => {
    if (!POSTING_EVENTS.has(event.type)) return;
    const id = event.payload.id ? String(event.payload.id) : "";
    if (!id) return;
    const key = failureKey(event.tenantId, event.orgId, event.type, id);
    try {
      await dispatchPosting(event.type, event.tenantId, event.orgId, id);
      postingFailures.delete(key); // recovered (or never failed)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const prev = postingFailures.get(key);
      postingFailures.set(key, {
        tenantId: event.tenantId,
        orgId: event.orgId,
        type: event.type,
        id,
        attempts: (prev?.attempts ?? 0) + 1,
        lastError: msg,
        firstAt: prev?.firstAt ?? event.at,
        lastAt: event.at,
        dead: false,
      });
      logger.error("auto-posting failed (queued for retry)", { event: event.type, id, error: msg });
    }
  });
}

/**
 * Re-run queued posting failures (idempotent, so safe to retry). Drives the GL +
 * stock ledger back into sync after a transient failure; a posting that still
 * fails after MAX_POSTING_ATTEMPTS is parked as dead-letter (kept for inspection,
 * not retried) and logged loudly. Called from the scheduler tick + /cron/tick.
 */
export async function retryFailedPostings(): Promise<{ retried: number; recovered: number; remaining: number; dead: number }> {
  let retried = 0;
  let recovered = 0;
  let dead = 0;
  for (const [key, f] of [...postingFailures.entries()]) {
    if (f.dead) continue;
    retried++;
    try {
      await dispatchPosting(f.type, f.tenantId, f.orgId, f.id);
      postingFailures.delete(key);
      recovered++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const attempts = f.attempts + 1;
      const isDead = attempts >= MAX_POSTING_ATTEMPTS;
      postingFailures.set(key, { ...f, attempts, lastError: msg, dead: isDead });
      if (isDead) {
        dead++;
        logger.error("auto-posting permanently failed (dead-letter)", { event: f.type, id: f.id, attempts, error: msg });
      }
    }
  }
  const remaining = [...postingFailures.values()].filter((x) => !x.dead).length;
  return { retried, recovered, remaining, dead };
}

/** Current posting failures for a tenant (diagnostics / admin surface). */
export function listPostingFailures(tenantId: string, orgId: string): PostingFailure[] {
  return [...postingFailures.values()].filter((f) => f.tenantId === tenantId && f.orgId === orgId);
}

/** Test/diagnostic helper: clear the posting-failure queue. */
export function clearPostingFailures(): void {
  postingFailures.clear();
}
