/**
 * The same product on a document TWICE.
 *
 * Entirely ordinary — an invoice quoting one item at two prices, a receipt
 * taking one item against two purchase-order lines — and it silently lost stock.
 * `writeMovement` is idempotent on `(ref, refType, product, warehouse, type)`,
 * which is what makes re-posting a document safe; the cost is that a document
 * could not produce two movements with the same key. The second line came back
 * as a duplicate of the first and its quantity never reached the ledger, while
 * the document total counted it in full.
 *
 * Sold twenty, deducted ten. Received fifteen, shelved ten. The paperwork and
 * the shelf disagreed and nothing anywhere said so.
 *
 * These tests are at the SERVICE level, not on the pure collapse helper: the
 * helper being right is not the claim — the claim is that the posting paths use
 * it, which is where the defect lived.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import type { RequestContext } from "@/lib/context/types";

const { getQueryEngine } = await import("@/lib/data/store");
const { systemContext } = await import("@/lib/context/resolver");
const { TENANT_ID, ORG_ID } = await import("@/lib/config/env");
const { getInventoryService } = await import("@/lib/inventory/service");
const { getFinanceService } = await import("@/lib/finance/service");
const { getPurchasingService } = await import("@/lib/purchasing/service");
const { postInvoiceGL } = await import("@/lib/accounting/postings");

const ctx = (): RequestContext => systemContext(TENANT_ID, ORG_ID);

let seq = 0;

async function scene(onHand = 0, cost = 10) {
  const qe = await getQueryEngine();
  const c = ctx();
  const n = ++seq;
  const warehouse = await qe.create(c, "warehouse", { name: `DW${n}`, code: `DW${n}` });
  const account = await qe.create(c, "account", { name: `Müşteri ${n}` });
  const supplier = await qe.create(c, "supplier", { name: `Tedarikçi ${n}` });
  const product = await qe.create(c, "product", {
    name: `Ürün ${n}`,
    sku: `DUP-${n}`,
    unitPrice: 100,
    trackStock: true,
  });
  if (onHand > 0) {
    const inventory = await getInventoryService();
    await inventory.writeMovement(c, {
      productId: String(product.id),
      warehouseId: String(warehouse.id),
      qty: onHand,
      unitCost: cost,
      type: "receipt",
      ref: `dup-seed-${n}`,
      refType: "adjustment",
      movedAt: c.at,
    });
  }
  return {
    c,
    qe,
    warehouse: String(warehouse.id),
    account: String(account.id),
    supplier: String(supplier.id),
    product: String(product.id),
  };
}

/** A PO's lines, oldest first — the order they were negotiated in. */
const orderLines = async (c: RequestContext, poId: string) => {
  const qe = await getQueryEngine();
  return (await qe.listComplete(c, "purchaseOrderLine", { filters: [{ field: "poId", op: "eq", value: poId }] })).sort(
    (a, b) => Number(a.id) - Number(b.id),
  );
};

const balance = async (c: RequestContext, product: string) => {
  const qe = await getQueryEngine();
  const rows = await qe.listComplete(c, "stockBalance", {
    filters: [{ field: "productId", op: "eq", value: product }],
  });
  return { qty: Number(rows[0]?.qty ?? 0), value: Number(rows[0]?.value ?? 0) };
};

test("an invoice with the same product on two lines issues BOTH", async () => {
  const s = await scene(100, 10);
  const finance = await getFinanceService();
  const invoice = await finance.createDocument(s.c, "invoice", "INV", {
    accountId: s.account,
    warehouseId: s.warehouse,
    currencyCode: "TRY",
    status: "draft",
    issueDate: "2026-08-09",
  });
  await finance.replaceLines(s.c, "invoice", "invoiceLine", "invoiceId", String(invoice.id), [
    // The ordinary case: a discounted line beside a full-price one.
    { productId: s.product, description: "Kampanya", qty: 10, unitPrice: 80, taxRate: 0 },
    { productId: s.product, description: "Liste", qty: 10, unitPrice: 100, taxRate: 0 },
  ]);

  await postInvoiceGL(s.c, String(invoice.id));

  const bal = await balance(s.c, s.product);
  assert.equal(bal.qty, 80, "twenty were sold, so twenty must leave");
  assert.equal(bal.value, 800);
});

test("the COGS posted equals the value the ledger actually removed", async () => {
  const s = await scene(100, 10);
  const finance = await getFinanceService();
  const invoice = await finance.createDocument(s.c, "invoice", "INV", {
    accountId: s.account,
    warehouseId: s.warehouse,
    currencyCode: "TRY",
    status: "draft",
    issueDate: "2026-08-09",
  });
  await finance.replaceLines(s.c, "invoice", "invoiceLine", "invoiceId", String(invoice.id), [
    { productId: s.product, description: "Kampanya", qty: 10, unitPrice: 80, taxRate: 0 },
    { productId: s.product, description: "Liste", qty: 10, unitPrice: 100, taxRate: 0 },
  ]);
  await postInvoiceGL(s.c, String(invoice.id));

  // Under-issuing also under-posted the COGS, so the invoice showed twice the
  // margin it earned. The GL and the stock ledger must state the same number.
  const entries = await s.qe.listComplete(s.c, "journalEntry", {
    filters: [
      { field: "source", op: "eq", value: "stockIssue" },
      { field: "sourceRef", op: "eq", value: String(invoice.id) },
    ],
  });
  const lines = await s.qe.listComplete(s.c, "journalLine", {
    filters: [{ field: "entryId", op: "eq", value: String(entries[0]?.id) }],
  });
  const debit = lines.reduce((t, l) => t + Number(l.debit ?? 0), 0);
  assert.equal(debit, 200, "20 units at an average of 10");
});

test("a goods receipt with the same product on two lines shelves BOTH", async () => {
  const s = await scene();
  const pur = await getPurchasingService();
  const { doc: po } = await pur.createPO(
    s.c,
    { supplierId: s.supplier, warehouseId: s.warehouse, currencyCode: "TRY" },
    [
      { productId: s.product, description: "ilk parti", qty: 10, unitPrice: 60, taxRate: 0 },
      { productId: s.product, description: "ikinci parti", qty: 5, unitPrice: 80, taxRate: 0 },
    ],
  );
  await s.qe.patchComputed(s.c, "purchaseOrder", String(po.id), { status: "approved" });
  const poLines = await orderLines(s.c, String(po.id));

  // Named per PO LINE — matching on the product alone is the very defect
  // `poLineId` was introduced to close, and it would collapse these two.
  const { doc: grn } = await pur.createGRN(s.c, { poId: String(po.id), warehouseId: s.warehouse }, [
    { poLineId: String(poLines[0]?.id), productId: s.product, qty: 10, unitCost: 60 },
    { poLineId: String(poLines[1]?.id), productId: s.product, qty: 5, unitCost: 80 },
  ]);
  await pur.applyGRN(s.c, String(grn.id));

  const bal = await balance(s.c, s.product);
  assert.equal(bal.qty, 15, "fifteen arrived, so fifteen go on the shelf");
  // Weighted, not averaged: 10×60 + 5×80 = 1000. A plain average of the two
  // prices would give 15 × 70 = 1050 and invent fifty lira of stock.
  assert.equal(bal.value, 1000);
});

test("re-posting a receipt with repeated products is still a no-op", async () => {
  // Collapsing must not cost the idempotency it was built around.
  const s = await scene();
  const pur = await getPurchasingService();
  const { doc: po } = await pur.createPO(
    s.c,
    { supplierId: s.supplier, warehouseId: s.warehouse, currencyCode: "TRY" },
    [
      { productId: s.product, description: "ilk parti", qty: 10, unitPrice: 60, taxRate: 0 },
      { productId: s.product, description: "ikinci parti", qty: 5, unitPrice: 80, taxRate: 0 },
    ],
  );
  await s.qe.patchComputed(s.c, "purchaseOrder", String(po.id), { status: "approved" });
  const poLines = await orderLines(s.c, String(po.id));
  const { doc: grn } = await pur.createGRN(s.c, { poId: String(po.id), warehouseId: s.warehouse }, [
    { poLineId: String(poLines[0]?.id), productId: s.product, qty: 10, unitCost: 60 },
    { poLineId: String(poLines[1]?.id), productId: s.product, qty: 5, unitCost: 80 },
  ]);

  await pur.applyGRN(s.c, String(grn.id));
  await pur.applyGRN(s.c, String(grn.id));

  const bal = await balance(s.c, s.product);
  assert.equal(bal.qty, 15);
  assert.equal(bal.value, 1000);
});
