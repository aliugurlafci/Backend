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
import { getAccountingService, type JournalLineInput } from "./service";
import { getInventoryService } from "@/lib/inventory/service";

const round2 = (n: number): number => Math.round(n * 100) / 100;
const today = (ctx: RequestContext): string => ctx.at.slice(0, 10);

/** Customer invoice → Dr AR, Cr Revenue (+ Cr Tax), then COGS for stock lines. */
export async function postInvoiceGL(ctx: RequestContext, invoiceId: string): Promise<void> {
  const qe = await getQueryEngine();
  const acc = await getAccountingService();
  const inv = await qe.get(ctx, "invoice", invoiceId);
  const total = round2(Number(inv.total ?? 0));
  if (total <= 0) return;
  const subtotal = round2(Number(inv.subtotal ?? 0));
  const tax = round2(Number(inv.taxTotal ?? 0));

  const lines: JournalLineInput[] = [
    { ledgerAccountId: await acc.requireAccount(ctx, "accounts_receivable"), debit: total },
    { ledgerAccountId: await acc.requireAccount(ctx, "sales_revenue"), credit: subtotal },
  ];
  if (tax > 0) lines.push({ ledgerAccountId: await acc.requireAccount(ctx, "tax_payable"), credit: tax });

  await acc.postFromSource(ctx, {
    source: "invoice",
    sourceRef: invoiceId,
    date: String(inv.issueDate ?? today(ctx)),
    memo: `Invoice ${String(inv.number)}`,
    branchId: (inv.branchId as string) ?? null,
    lines,
  });

  await postInvoiceCOGS(ctx, inv);
}

/** Issue stock + post COGS for each stock-tracked invoice line. */
async function postInvoiceCOGS(ctx: RequestContext, inv: EntityRecord): Promise<void> {
  const qe = await getQueryEngine();
  const acc = await getAccountingService();
  const inventory = await getInventoryService();

  const linesPage = await qe.list(ctx, "invoiceLine", {
    filters: [{ field: "invoiceId", op: "eq", value: inv.id }],
    pageSize: 200,
  });

  // Resolve a warehouse to issue from: the invoice's branch, else any warehouse.
  const branchWh = inv.branchId
    ? (await qe.list(ctx, "warehouse", { filters: [{ field: "branchId", op: "eq", value: inv.branchId }], pageSize: 1 })).items[0]
    : undefined;
  const warehouse = branchWh ?? (await qe.list(ctx, "warehouse", { pageSize: 1 })).items[0];
  if (!warehouse) return;

  let cogsTotal = 0;
  for (const line of linesPage.items) {
    if (!line.productId) continue;
    const product = await qe.get(ctx, "product", String(line.productId));
    if (!product.trackStock) continue;
    const qty = Number(line.qty ?? 0);
    if (qty <= 0) continue;
    const cost = round2(Number(product.costPrice ?? 0));
    await inventory.writeMovement(ctx, {
      productId: String(line.productId),
      warehouseId: String(warehouse.id),
      qty: -qty,
      type: "issue",
      unitCost: cost,
      ref: String(inv.id),
      refType: "invoice",
      branchId: (inv.branchId as string) ?? null,
      movedAt: ctx.at,
    });
    cogsTotal += round2(qty * cost);
  }
  cogsTotal = round2(cogsTotal);
  if (cogsTotal <= 0) return;

  await acc.postFromSource(ctx, {
    source: "stockIssue",
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

/** Customer payment → Dr Cash/Bank, Cr AR. */
export async function postPaymentGL(ctx: RequestContext, payment: EntityRecord): Promise<void> {
  const acc = await getAccountingService();
  const amount = round2(Number(payment.amount ?? 0));
  if (amount <= 0) return;
  await acc.postFromSource(ctx, {
    source: "payment",
    sourceRef: String(payment.id),
    date: String(payment.paidAt ?? today(ctx)),
    memo: `Payment ${String(payment.number)}`,
    branchId: (payment.branchId as string) ?? null,
    lines: [
      { ledgerAccountId: await acc.requireAccount(ctx, "cash"), debit: amount },
      { ledgerAccountId: await acc.requireAccount(ctx, "accounts_receivable"), credit: amount },
    ],
  });
}

/** Goods receipt → Dr Inventory, Cr GR/IR clearing. */
export async function postGoodsReceiptGL(
  ctx: RequestContext,
  grn: EntityRecord,
  lines: { qty: number; unitCost: number }[],
): Promise<void> {
  const acc = await getAccountingService();
  let total = 0;
  for (const l of lines) total += round2(Number(l.qty) * Number(l.unitCost ?? 0));
  total = round2(total);
  if (total <= 0) return;
  await acc.postFromSource(ctx, {
    source: "goodsReceipt",
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

/** Vendor bill received → Dr GR/IR (or Expense) + Tax, Cr Accounts Payable. */
export async function postVendorBillGL(ctx: RequestContext, bill: EntityRecord): Promise<void> {
  const acc = await getAccountingService();
  const total = round2(Number(bill.total ?? 0));
  if (total <= 0) return;
  const subtotal = round2(Number(bill.subtotal ?? 0));
  const tax = round2(Number(bill.taxTotal ?? 0));
  // 3-way match: if linked to a GRN the stock is already in Inventory via GR/IR; else expense it.
  const debitSubtype = bill.goodsReceiptId ? "gr_ir" : "operating_expense";
  const lines: JournalLineInput[] = [
    { ledgerAccountId: await acc.requireAccount(ctx, debitSubtype), debit: subtotal },
    { ledgerAccountId: await acc.requireAccount(ctx, "accounts_payable"), credit: total },
  ];
  if (tax > 0) lines.push({ ledgerAccountId: await acc.requireAccount(ctx, "tax_payable"), debit: tax });
  await acc.postFromSource(ctx, {
    source: "vendorBill",
    sourceRef: String(bill.id),
    date: String(bill.billDate ?? today(ctx)),
    memo: `Vendor bill ${String(bill.number)}`,
    branchId: (bill.branchId as string) ?? null,
    lines,
  });
}

/** Bill payment → Dr Accounts Payable, Cr Cash/Bank. */
export async function postBillPaymentGL(ctx: RequestContext, payment: EntityRecord): Promise<void> {
  const acc = await getAccountingService();
  const amount = round2(Number(payment.amount ?? 0));
  if (amount <= 0) return;
  await acc.postFromSource(ctx, {
    source: "billPayment",
    sourceRef: String(payment.id),
    date: String(payment.paidAt ?? today(ctx)),
    memo: `Bill payment ${String(payment.number)}`,
    branchId: (payment.branchId as string) ?? null,
    lines: [
      { ledgerAccountId: await acc.requireAccount(ctx, "accounts_payable"), debit: amount },
      { ledgerAccountId: await acc.requireAccount(ctx, "cash"), credit: amount },
    ],
  });
}

/** Post a stock transfer: paired transfer_out / transfer_in movements (no GL). */
export async function postStockTransfer(ctx: RequestContext, transferId: string): Promise<EntityRecord> {
  const qe = await getQueryEngine();
  const inventory = await getInventoryService();
  const t = await qe.get(ctx, "stockTransfer", transferId);
  if (t.status === "posted") return t;
  const qty = Number(t.qty ?? 0);
  const cost = round2(Number(t.unitCost ?? 0));
  await inventory.writeMovement(ctx, { productId: String(t.productId), warehouseId: String(t.fromWarehouseId), qty: -qty, type: "transfer_out", unitCost: cost, ref: transferId, refType: "stockTransfer", branchId: (t.branchId as string) ?? null, movedAt: ctx.at });
  await inventory.writeMovement(ctx, { productId: String(t.productId), warehouseId: String(t.toWarehouseId), qty, type: "transfer_in", unitCost: cost, ref: transferId, refType: "stockTransfer", branchId: (t.branchId as string) ?? null, movedAt: ctx.at });
  return qe.patchComputed(ctx, "stockTransfer", transferId, { status: "posted" });
}

/** Post a stock adjustment: a signed movement + a GL entry (Inventory vs Adjustments). */
export async function postStockAdjustment(ctx: RequestContext, adjId: string): Promise<EntityRecord> {
  const qe = await getQueryEngine();
  const inventory = await getInventoryService();
  const acc = await getAccountingService();
  const a = await qe.get(ctx, "stockAdjustment", adjId);
  if (a.status === "posted") return a;
  const delta = Number(a.qtyDelta ?? 0);
  const cost = round2(Number(a.unitCost ?? 0));
  if (delta !== 0) {
    await inventory.writeMovement(ctx, { productId: String(a.productId), warehouseId: String(a.warehouseId), qty: delta, type: "adjustment", unitCost: cost, ref: adjId, refType: "adjustment", branchId: (a.branchId as string) ?? null, movedAt: ctx.at });
    const value = round2(Math.abs(delta) * cost);
    if (value > 0) {
      const inv = await acc.requireAccount(ctx, "inventory");
      const adjustExpenseAcc = (await acc.accountBySubtype(ctx, "operating_expense"))?.id ?? inv;
      const lines: JournalLineInput[] = delta > 0
        ? [{ ledgerAccountId: inv, debit: value }, { ledgerAccountId: adjustExpenseAcc, credit: value }]
        : [{ ledgerAccountId: adjustExpenseAcc, debit: value }, { ledgerAccountId: inv, credit: value }];
      await acc.postFromSource(ctx, { source: "adjustment", sourceRef: adjId, date: String(a.adjustedAt ?? today(ctx)), memo: `Adjustment ${String(a.number)}`, branchId: (a.branchId as string) ?? null, lines });
    }
  }
  return qe.patchComputed(ctx, "stockAdjustment", adjId, { status: "posted" });
}

/** Subscribe to the invoice `send` transition so AR/Revenue/COGS post automatically. */
export function registerAccountingPostings(): void {
  eventBus.subscribe("*", async (event: DomainEvent) => {
    try {
      if (event.type === "invoice.send") {
        const ctx = systemContext(event.tenantId, event.orgId);
        await postInvoiceGL(ctx, String(event.payload.id));
      }
    } catch (error) {
      logger.error("auto-posting failed", { event: event.type, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
