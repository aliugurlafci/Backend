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
  });
}

/** Resolve the warehouse an invoice issues stock from: its explicit warehouse
 *  (POS / picking), else its branch's warehouse, else any warehouse. */
async function resolveIssueWarehouse(ctx: RequestContext, inv: EntityRecord): Promise<EntityRecord | undefined> {
  const qe = await getQueryEngine();
  const explicitWh = inv.warehouseId ? await qe.get(ctx, "warehouse", String(inv.warehouseId)).catch(() => undefined) : undefined;
  const branchWh = !explicitWh && inv.branchId
    ? (await qe.list(ctx, "warehouse", { filters: [{ field: "branchId", op: "eq", value: inv.branchId }], pageSize: 1 })).items[0]
    : undefined;
  return explicitWh ?? branchWh ?? (await qe.list(ctx, "warehouse", { pageSize: 1 })).items[0];
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

  const warehouse = await resolveIssueWarehouse(ctx, inv);
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
    if (tax > 0) arLines.splice(1, 0, { ledgerAccountId: await acc.requireAccount(ctx, "tax_payable"), debit: tax });
    await acc.postFromSource(ctx, {
      source: "invoiceVoid",
      sourceRef: invoiceId,
      date: today(ctx),
      memo: `Void invoice ${String(inv.number)}`,
      branchId: (inv.branchId as string) ?? null,
      lines: arLines,
    });

    // Restock issued goods (receipt) + reverse COGS (Dr Inventory, Cr COGS).
    const warehouse = await resolveIssueWarehouse(ctx, inv);
    if (!warehouse) return;
    const linesPage = await qe.list(ctx, "invoiceLine", { filters: [{ field: "invoiceId", op: "eq", value: inv.id }], pageSize: 200 });
    let cogsTotal = 0;
    for (const line of linesPage.items) {
      if (!line.productId) continue;
      const product = await qe.get(ctx, "product", String(line.productId));
      if (!product.trackStock) continue;
      const qty = Number(line.qty ?? 0);
      if (qty <= 0) continue;
      const cost = round2(Number(product.costPrice ?? 0));
      await inventory.writeMovement(ctx, {
        productId: String(line.productId), warehouseId: String(warehouse.id), qty,
        type: "receipt", unitCost: cost, ref: `${String(inv.id)}:void`, refType: "invoice",
        branchId: (inv.branchId as string) ?? null, movedAt: ctx.at,
      });
      cogsTotal += round2(qty * cost);
    }
    cogsTotal = round2(cogsTotal);
    if (cogsTotal > 0) {
      await acc.postFromSource(ctx, {
        source: "stockIssueVoid",
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
    const grnLines = await qe.list(ctx, "goodsReceiptLine", { filters: [{ field: "grnId", op: "eq", value: bill.goodsReceiptId }], pageSize: 500 });
    const grnValue = round2(grnLines.items.reduce((s, l) => s + Number(l.qty ?? 0) * Number(l.unitCost ?? 0), 0));
    lines.push({ ledgerAccountId: await acc.requireAccount(ctx, "gr_ir"), debit: grnValue });
    // …and book the receipt-vs-bill difference as a purchase price variance.
    const variance = round2(subtotal - grnValue);
    if (Math.abs(variance) >= 0.005) {
      const ppv = await acc.requireAccount(ctx, "purchase_price_variance");
      lines.push(variance > 0 ? { ledgerAccountId: ppv, debit: variance } : { ledgerAccountId: ppv, credit: -variance });
    }
  } else {
    // No GRN linked → straight expense.
    lines.push({ ledgerAccountId: await acc.requireAccount(ctx, "operating_expense"), debit: subtotal });
  }

  lines.push({ ledgerAccountId: await acc.requireAccount(ctx, "accounts_payable"), credit: total });
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

/** Write the paired transfer_out / transfer_in movements for a transfer record
 *  (idempotent via the ledger; net-zero on total on-hand). No status change. */
async function applyTransferMovements(ctx: RequestContext, t: EntityRecord): Promise<void> {
  const qty = Number(t.qty ?? 0);
  if (qty <= 0) return;
  const inventory = await getInventoryService();
  const cost = round2(Number(t.unitCost ?? 0));
  const branchId = (t.branchId as string) ?? null;
  await inventory.writeMovement(ctx, { productId: String(t.productId), warehouseId: String(t.fromWarehouseId), qty: -qty, type: "transfer_out", unitCost: cost, ref: String(t.id), refType: "stockTransfer", branchId, movedAt: ctx.at });
  await inventory.writeMovement(ctx, { productId: String(t.productId), warehouseId: String(t.toWarehouseId), qty, type: "transfer_in", unitCost: cost, ref: String(t.id), refType: "stockTransfer", branchId, movedAt: ctx.at });
}

/** Reverse a posted transfer's movements (idempotent via a distinct `:void` ref
 *  so re-voiding is a no-op and the reversal never collides with the forward keys). */
async function reverseTransferMovements(ctx: RequestContext, t: EntityRecord): Promise<void> {
  const qty = Number(t.qty ?? 0);
  if (qty <= 0) return;
  const inventory = await getInventoryService();
  const cost = round2(Number(t.unitCost ?? 0));
  const branchId = (t.branchId as string) ?? null;
  const ref = `${String(t.id)}:void`;
  await inventory.writeMovement(ctx, { productId: String(t.productId), warehouseId: String(t.fromWarehouseId), qty, type: "transfer_in", unitCost: cost, ref, refType: "stockTransfer", branchId, movedAt: ctx.at });
  await inventory.writeMovement(ctx, { productId: String(t.productId), warehouseId: String(t.toWarehouseId), qty: -qty, type: "transfer_out", unitCost: cost, ref, refType: "stockTransfer", branchId, movedAt: ctx.at });
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
  const cost = round2(Number(a.unitCost ?? 0));
  const branchId = (a.branchId as string) ?? null;
  await inventory.writeMovement(ctx, { productId: String(a.productId), warehouseId: String(a.warehouseId), qty: delta, type: "adjustment", unitCost: cost, ref: String(a.id), refType: "adjustment", branchId, movedAt: ctx.at });
  const value = round2(Math.abs(delta) * cost);
  if (value > 0) {
    const invAcc = await acc.requireAccount(ctx, "inventory");
    const adjustExpenseAcc = (await acc.accountBySubtype(ctx, "operating_expense"))?.id ?? invAcc;
    const lines: JournalLineInput[] = delta > 0
      ? [{ ledgerAccountId: invAcc, debit: value }, { ledgerAccountId: adjustExpenseAcc, credit: value }]
      : [{ ledgerAccountId: adjustExpenseAcc, debit: value }, { ledgerAccountId: invAcc, credit: value }];
    await acc.postFromSource(ctx, { source: "adjustment", sourceRef: String(a.id), date: String(a.adjustedAt ?? today(ctx)), memo: `Adjustment ${String(a.number)}`, branchId, lines });
  }
}

/** Reverse a posted adjustment: opposite movement + reversing GL, keyed on a
 *  distinct `:void` ref so re-voiding is idempotent. */
async function reverseAdjustmentPosting(ctx: RequestContext, a: EntityRecord): Promise<void> {
  const delta = Number(a.qtyDelta ?? 0);
  if (delta === 0) return;
  const inventory = await getInventoryService();
  const acc = await getAccountingService();
  const cost = round2(Number(a.unitCost ?? 0));
  const branchId = (a.branchId as string) ?? null;
  const ref = `${String(a.id)}:void`;
  await inventory.writeMovement(ctx, { productId: String(a.productId), warehouseId: String(a.warehouseId), qty: -delta, type: "adjustment", unitCost: cost, ref, refType: "adjustment", branchId, movedAt: ctx.at });
  const value = round2(Math.abs(delta) * cost);
  if (value > 0) {
    const invAcc = await acc.requireAccount(ctx, "inventory");
    const adjustExpenseAcc = (await acc.accountBySubtype(ctx, "operating_expense"))?.id ?? invAcc;
    const lines: JournalLineInput[] = delta > 0
      ? [{ ledgerAccountId: adjustExpenseAcc, debit: value }, { ledgerAccountId: invAcc, credit: value }]
      : [{ ledgerAccountId: invAcc, debit: value }, { ledgerAccountId: adjustExpenseAcc, credit: value }];
    await acc.postFromSource(ctx, { source: "adjustment", sourceRef: ref, date: String(a.adjustedAt ?? today(ctx)), memo: `Void adjustment ${String(a.number)}`, branchId, lines });
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

/** The lifecycle events that produce GL entries / stock movements. */
const POSTING_EVENTS = new Set([
  "invoice.send",
  "invoice.void",
  "stockTransfer.post",
  "stockTransfer.void",
  "stockAdjustment.post",
  "stockAdjustment.void",
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
    case "stockTransfer.void":
      await reverseTransferMovements(ctx, await qe.get(ctx, "stockTransfer", id));
      break;
    case "stockAdjustment.post":
      await applyAdjustmentPosting(ctx, await qe.get(ctx, "stockAdjustment", id));
      break;
    case "stockAdjustment.void":
      await reverseAdjustmentPosting(ctx, await qe.get(ctx, "stockAdjustment", id));
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
