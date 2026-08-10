/**
 * Sending goods back to a supplier — alım iadesi.
 *
 * The customer side has always existed; this side did not, so a damaged pallet
 * had nowhere to go. It was either left on the books as stock we did not have,
 * or written off — which puts the cost in the P&L rather than on the supplier's
 * account, and the next payment run pays for goods that went back.
 *
 * The rule under test: goods leave at the MOVING AVERAGE, and the difference
 * between that and what the supplier is crediting is named rather than fudged.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import type { RequestContext } from "@/lib/context/types";

const { getQueryEngine } = await import("@/lib/data/store");
const { systemContext } = await import("@/lib/context/resolver");
const { TENANT_ID, ORG_ID } = await import("@/lib/config/env");
const { getPurchasingService } = await import("@/lib/purchasing/service");
const { getFinanceService } = await import("@/lib/finance/service");
const { getInventoryService } = await import("@/lib/inventory/service");
const { postPurchaseReturn, voidPurchaseReturn } = await import("@/lib/purchasing/returns");

const ctx = (): RequestContext => systemContext(TENANT_ID, ORG_ID);
const round2 = (n: number): number => Math.round(n * 100) / 100;

let seq = 0;

/** 100 units received at 10 from one supplier. */
async function received() {
  const qe = await getQueryEngine();
  const c = ctx();
  const n = ++seq;
  const warehouse = await qe.create(c, "warehouse", { name: `PRW${n}`, code: `PRW${n}` });
  const supplier = await qe.create(c, "supplier", { name: `PR Tedarikçi ${n}` });
  const product = await qe.create(c, "product", { name: `PR Ürün ${n}`, sku: `PR-${n}`, unitPrice: 20, trackStock: true });

  const pur = await getPurchasingService();
  const { doc: po } = await pur.createPO(
    c,
    { supplierId: String(supplier.id), warehouseId: String(warehouse.id), currencyCode: "TRY" },
    [{ productId: String(product.id), description: "alım", qty: 100, unitPrice: 10, taxRate: 20 }],
  );
  await qe.patchComputed(c, "purchaseOrder", String(po.id), { status: "approved" });
  const { doc: grn } = await pur.createGRN(c, { poId: String(po.id), warehouseId: String(warehouse.id) }, [
    { productId: String(product.id), qty: 100, unitCost: 10 },
  ]);
  await pur.applyGRN(c, String(grn.id));

  return { c, qe, warehouse: String(warehouse.id), supplier: String(supplier.id), product: String(product.id), grn: String(grn.id) };
}

const balance = async (c: RequestContext, productId: string) => {
  const qe = await getQueryEngine();
  const rows = await qe.listComplete(c, "stockBalance", {
    filters: [{ field: "productId", op: "eq", value: productId }],
  });
  return { qty: Number(rows[0]?.qty ?? 0), value: Number(rows[0]?.value ?? 0) };
};

/** The posted journal entry for a source, as {subtype: net debit}. */
async function entryOf(c: RequestContext, source: string, ref: string) {
  const qe = await getQueryEngine();
  const entries = await qe.listComplete(c, "journalEntry", {
    filters: [
      { field: "source", op: "eq", value: source },
      { field: "sourceRef", op: "eq", value: ref },
    ],
  });
  const entry = entries[0];
  if (!entry) return null;
  const lines = await qe.listComplete(c, "journalLine", {
    filters: [{ field: "entryId", op: "eq", value: String(entry.id) }],
  });
  const accounts = await qe.listComplete(c, "ledgerAccount", {
    filters: [{ field: "id", op: "in", value: lines.map((l) => String(l.ledgerAccountId)) }],
  });
  const subtypeOf = new Map(accounts.map((a) => [String(a.id), String(a.subtype)]));
  const out: Record<string, number> = {};
  for (const l of lines) {
    const key = subtypeOf.get(String(l.ledgerAccountId)) ?? "?";
    out[key] = round2((out[key] ?? 0) + Number(l.debit ?? 0) - Number(l.credit ?? 0));
  }
  return out;
}

async function makeReturn(
  s: Awaited<ReturnType<typeof received>>,
  qty: number,
  opts: { billed?: boolean; unitPrice?: number } = {},
) {
  const finance = await getFinanceService();
  const doc = await finance.createDocument(s.c, "purchaseReturn", "AIA", {
    supplierId: s.supplier,
    grnId: s.grn,
    vendorBillId: opts.billed ? "vb-1" : null,
    warehouseId: s.warehouse,
    currencyCode: "TRY",
    returnDate: s.c.at.slice(0, 10),
    reason: "Hasarlı",
    status: "draft",
  });
  await finance.replaceLines(s.c, "purchaseReturn", "purchaseReturnLine", "returnId", String(doc.id), [
    { productId: s.product, description: "iade", qty, unitPrice: opts.unitPrice ?? 10, taxRate: 20 },
  ]);
  return String(doc.id);
}

test("returning goods takes them off the shelf at cost", async () => {
  const s = await received();
  const returnId = await makeReturn(s, 10);
  await postPurchaseReturn(s.c, returnId);

  const bal = await balance(s.c, s.product);
  assert.equal(bal.qty, 90);
  assert.equal(bal.value, 900, "ten units at the average of 10");
});

test("unbilled goods reverse the accrual, not the payable", async () => {
  // Nothing was ever invoiced, so nothing is payable. Crediting AP would leave
  // the supplier's account showing a credit that no invoice will ever clear.
  const s = await received();
  const returnId = await makeReturn(s, 10);
  await postPurchaseReturn(s.c, returnId);

  const entry = await entryOf(s.c, "purchaseReturn", returnId);
  assert.ok(entry);
  assert.equal(entry.accounts_payable, undefined);
  assert.equal(entry.gr_ir, 100, "the accrual the receipt raised");
  assert.equal(entry.inventory, -100);
});

test("billed goods reverse the payable and the input VAT", async () => {
  const s = await received();
  const returnId = await makeReturn(s, 10, { billed: true });
  await postPurchaseReturn(s.c, returnId);

  const entry = await entryOf(s.c, "purchaseReturn", returnId);
  assert.ok(entry);
  assert.equal(entry.accounts_payable, 120, "100 plus 20% KDV no longer owed");
  // İndirilecek KDV (191), NOT Hesaplanan (391): the VAT on goods sent back is
  // input VAT that is no longer deductible.
  assert.equal(entry.vat_deductible, -20);
  assert.equal(entry.inventory, -100);
});

test("the gap between the credit and the carrying cost goes to price variance", async () => {
  // Received at 10, but a later receipt moved the average — and the supplier is
  // crediting the original price. The difference is real and is named.
  const s = await received();
  const inventory = await getInventoryService();
  await inventory.writeMovement(s.c, {
    productId: s.product,
    warehouseId: s.warehouse,
    qty: 100,
    unitCost: 14,
    type: "receipt",
    ref: `pr-second-${seq}`,
    refType: "adjustment",
    movedAt: s.c.at,
  });
  // 200 units, 2400 of value → an average of 12.
  assert.equal((await balance(s.c, s.product)).value, 2400);

  const returnId = await makeReturn(s, 10, { billed: true, unitPrice: 10 });
  await postPurchaseReturn(s.c, returnId);

  const entry = await entryOf(s.c, "purchaseReturn", returnId);
  assert.ok(entry);
  assert.equal(entry.accounts_payable, 120, "the supplier credits what they charged");
  assert.equal(entry.inventory, -120, "but 10 units left at the average of 12");
  assert.equal(entry.purchase_price_variance, 20, "and the 20 lira difference is named");
});

test("a return posts once however many times it is run", async () => {
  const s = await received();
  const returnId = await makeReturn(s, 10);
  await postPurchaseReturn(s.c, returnId);
  await postPurchaseReturn(s.c, returnId);
  assert.equal((await balance(s.c, s.product)).qty, 90);
});

test("the same product on two return lines sends both back", async () => {
  // `writeMovement` is idempotent on (ref, refType, product, warehouse, type),
  // so without collapsing the second line comes back as a duplicate and its
  // goods stay on the shelf while the supplier is credited for them.
  const s = await received();
  const finance = await getFinanceService();
  const doc = await finance.createDocument(s.c, "purchaseReturn", "AIA", {
    supplierId: s.supplier,
    warehouseId: s.warehouse,
    currencyCode: "TRY",
    returnDate: s.c.at.slice(0, 10),
    status: "draft",
  });
  await finance.replaceLines(s.c, "purchaseReturn", "purchaseReturnLine", "returnId", String(doc.id), [
    { productId: s.product, description: "hasarlı", qty: 4, unitPrice: 10, taxRate: 0 },
    { productId: s.product, description: "eksik", qty: 6, unitPrice: 10, taxRate: 0 },
  ]);
  await postPurchaseReturn(s.c, String(doc.id));

  assert.equal((await balance(s.c, s.product)).qty, 90, "all ten went back");
});

test("voiding a return brings the goods back at the value that left", async () => {
  const s = await received();
  const returnId = await makeReturn(s, 10, { billed: true });
  await postPurchaseReturn(s.c, returnId);
  await voidPurchaseReturn(s.c, returnId);

  const bal = await balance(s.c, s.product);
  assert.equal(bal.qty, 100);
  assert.equal(bal.value, 1000, "exactly where it started");

  const entry = await entryOf(s.c, "purchaseReturnVoid", returnId);
  assert.ok(entry);
  assert.equal(entry.accounts_payable, -120, "the payable is back");
  assert.equal(entry.inventory, 100);
});

test("voiding a return that never posted does nothing", async () => {
  const s = await received();
  const returnId = await makeReturn(s, 10);
  await voidPurchaseReturn(s.c, returnId);
  assert.equal((await balance(s.c, s.product)).qty, 100);
});

test("a return cannot be raised without a warehouse", async () => {
  // The goods leave a real place. Without one there is no balance to take them
  // out of, and the credit would be raised against nothing.
  //
  // Caught by the metadata (`required: true`) rather than by the service, which
  // is the earlier and better of the two — the document never comes into
  // existence. The service keeps its own guard for anything that reaches it by
  // another route.
  const s = await received();
  const finance = await getFinanceService();
  await assert.rejects(
    () =>
      finance.createDocument(s.c, "purchaseReturn", "AIA", {
        supplierId: s.supplier,
        warehouseId: null,
        currencyCode: "TRY",
        status: "draft",
      }),
    // The field is named in `details`, not in the message: the API reports
    // per-field failures so a client can point at the input that was wrong.
    (err: unknown) => {
      const details = (err as { details?: { field: string }[] }).details ?? [];
      assert.ok(details.some((d) => d.field === "warehouseId"), JSON.stringify(details));
      return true;
    },
  );
});
