/**
 * Freight, duty and insurance added to what goods cost.
 *
 * A container bought at 100 is on the shelf at 118. Booking the extra 18 to an
 * expense account and valuing the stock at 100 understates inventory, overstates
 * the month's expenses, and then reports a margin on every sale out of that
 * container that was never earned. VUK md. 262 puts these inside maliyet bedeli,
 * so it is a requirement rather than a preference.
 *
 * Two properties hold this together:
 *
 *  - **The parts add back to the whole.** A 100 lira charge over three lines
 *    must put exactly 100 lira into the balances — not 99.99. Every kuruş that
 *    vanishes in a rounding step is a kuruş by which the GL and the stock ledger
 *    disagree for ever.
 *  - **The reversal cannot go negative.** Voiding a charge after the goods have
 *    been sold has nothing left to take it out of, and a negative inventory
 *    value is exactly the defect the costing rebuild removed.
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
const { getPurchasingService } = await import("@/lib/purchasing/service");
const { allocate, applyLandedCost, voidLandedCost, previewLandedCost } = await import("@/lib/purchasing/landed-cost");
const { priceFor, suppliersFor } = await import("@/lib/purchasing/supplier-price");

const ctx = (): RequestContext => systemContext(TENANT_ID, ORG_ID);
const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---- the allocation arithmetic, with no database in sight ----------------

const line = (over: Partial<Parameters<typeof allocate>[0][number]> = {}) => ({
  productId: "p",
  warehouseId: "w",
  qtyBase: 1,
  lineValue: 0,
  weightKg: 0,
  volumeM3: 0,
  ...over,
});

test("by value: the expensive line carries more of the duty", () => {
  const shares = allocate(
    [line({ productId: "a", lineValue: 750 }), line({ productId: "b", lineValue: 250 })],
    100,
    "value",
  );
  assert.deepEqual(shares.map((s) => s.share), [75, 25]);
});

test("by quantity: a pallet of feathers pays the same freight as a pallet of tiles", () => {
  // Which is why freight is not allocated by value: the cheap bulky thing takes
  // up the lorry too.
  const shares = allocate(
    [line({ productId: "a", qtyBase: 10, lineValue: 10_000 }), line({ productId: "b", qtyBase: 10, lineValue: 100 })],
    200,
    "quantity",
  );
  assert.deepEqual(shares.map((s) => s.share), [100, 100]);
});

test("by weight and by volume use quantity × the product's measurement", () => {
  const byWeight = allocate(
    [line({ productId: "a", qtyBase: 2, weightKg: 30 }), line({ productId: "b", qtyBase: 4, weightKg: 5 })],
    160,
    "weight",
  );
  assert.deepEqual(byWeight.map((s) => s.share), [120, 40]); // 60 kg vs 20 kg

  const byVolume = allocate(
    [line({ productId: "a", qtyBase: 1, volumeM3: 3 }), line({ productId: "b", qtyBase: 1, volumeM3: 1 })],
    80,
    "volume",
  );
  assert.deepEqual(byVolume.map((s) => s.share), [60, 20]);
});

test("the parts add back to the whole, to the kuruş", () => {
  // 100 over three equal lines is 33.33 three times — and a lost kuruş, which is
  // a permanent disagreement between the GL and the stock ledger.
  const shares = allocate(
    [line({ productId: "a", lineValue: 1 }), line({ productId: "b", lineValue: 1 }), line({ productId: "c", lineValue: 1 })],
    100,
    "value",
  );
  assert.equal(round2(shares.reduce((t, s) => t + s.share, 0)), 100);
  assert.deepEqual(shares.map((s) => s.share), [33.33, 33.33, 33.34]);
});

test("an awkward split still adds up", () => {
  const shares = allocate(
    [line({ productId: "a", lineValue: 3 }), line({ productId: "b", lineValue: 3 }), line({ productId: "c", lineValue: 1 })],
    10.01,
    "value",
  );
  assert.equal(round2(shares.reduce((t, s) => t + s.share, 0)), 10.01);
});

test("with no basis at all the charge is split evenly rather than lost", () => {
  // Nothing weighs anything. The freight is still real and has to land
  // somewhere; refusing would leave it unallocated, which is worse.
  const shares = allocate([line({ productId: "a" }), line({ productId: "b" })], 50, "weight");
  assert.deepEqual(shares.map((s) => s.share), [25, 25]);
});

test("nothing to allocate onto yields nothing", () => {
  assert.deepEqual(allocate([], 100, "value"), []);
});

// ---- against the real service -------------------------------------------

let seq = 0;

/** A posted receipt: 100 of A at 10 and 100 of B at 2, in one warehouse. */
async function receivedContainer() {
  const qe = await getQueryEngine();
  const c = ctx();
  const n = ++seq;
  const warehouse = await qe.create(c, "warehouse", { name: `LCW${n}`, code: `LCW${n}` });
  const supplier = await qe.create(c, "supplier", { name: `LC Tedarikçi ${n}` });
  const dear = await qe.create(c, "product", { name: `Pahalı ${n}`, sku: `LC-D${n}`, unitPrice: 20, trackStock: true, weightKg: 1 });
  const cheap = await qe.create(c, "product", { name: `Ucuz ${n}`, sku: `LC-C${n}`, unitPrice: 4, trackStock: true, weightKg: 1 });

  const pur = await getPurchasingService();
  const { doc: po } = await pur.createPO(
    c,
    { supplierId: String(supplier.id), warehouseId: String(warehouse.id), currencyCode: "TRY" },
    [
      { productId: String(dear.id), description: "pahalı", qty: 100, unitPrice: 10, taxRate: 0 },
      { productId: String(cheap.id), description: "ucuz", qty: 100, unitPrice: 2, taxRate: 0 },
    ],
  );
  await qe.patchComputed(c, "purchaseOrder", String(po.id), { status: "approved" });
  const { doc: grn } = await pur.createGRN(c, { poId: String(po.id), warehouseId: String(warehouse.id) }, [
    { productId: String(dear.id), qty: 100, unitCost: 10 },
    { productId: String(cheap.id), qty: 100, unitCost: 2 },
  ]);
  await pur.applyGRN(c, String(grn.id));

  return { c, qe, warehouse: String(warehouse.id), supplier: String(supplier.id), dear: String(dear.id), cheap: String(cheap.id), grn: String(grn.id) };
}

const balance = async (c: RequestContext, productId: string) => {
  const qe = await getQueryEngine();
  const rows = await qe.listComplete(c, "stockBalance", {
    filters: [{ field: "productId", op: "eq", value: productId }],
  });
  return { qty: Number(rows[0]?.qty ?? 0), value: Number(rows[0]?.value ?? 0), avgCost: Number(rows[0]?.avgCost ?? 0) };
};

async function landedCost(s: Awaited<ReturnType<typeof receivedContainer>>, amount: number, method: string) {
  const finance = await (await import("@/lib/finance/service")).getFinanceService();
  return finance.createDocument(s.c, "landedCost", "LC", {
    grnId: s.grn,
    supplierId: s.supplier,
    costType: "freight",
    allocationMethod: method,
    amount,
    currencyCode: "TRY",
    costDate: s.c.at.slice(0, 10),
    status: "draft",
  });
}

test("applying freight raises the moving average of the goods it arrived with", async () => {
  const s = await receivedContainer();
  assert.equal((await balance(s.c, s.dear)).avgCost, 10);

  // 240 by value: the dear line is 1000 of the 1200 received, so it takes 200.
  const cost = await landedCost(s, 240, "value");
  const applied = await applyLandedCost(s.c, String(cost.id));
  assert.equal(applied, 240, "every lira reached a balance");

  const dear = await balance(s.c, s.dear);
  const cheap = await balance(s.c, s.cheap);
  assert.equal(dear.value, 1200);
  assert.equal(dear.avgCost, 12, "goods that cost 10 to buy cost 12 to have");
  assert.equal(cheap.value, 240);
  assert.equal(cheap.avgCost, 2.4);
});

test("the freight goes out with the goods, at the higher cost", async () => {
  const s = await receivedContainer();
  const cost = await landedCost(s, 240, "value");
  await applyLandedCost(s.c, String(cost.id));

  const inventory = await getInventoryService();
  const issue = await inventory.writeMovement(s.c, {
    productId: s.dear,
    warehouseId: s.warehouse,
    qty: -10,
    type: "issue",
    ref: `lc-sale-${seq}`,
    refType: "invoice",
    movedAt: s.c.at,
  });
  // 120, not 100. Without landed cost the sale would report 20 lira of margin
  // that the freight had already spent.
  assert.equal(-issue.valueDelta, 120);
});

test("preview shows the split without changing a balance", async () => {
  const s = await receivedContainer();
  const cost = await landedCost(s, 240, "value");
  const { shares } = await previewLandedCost(s.c, String(cost.id));
  assert.equal(shares.length, 2);
  assert.equal(round2(shares.reduce((t, x) => t + x.share, 0)), 240);
  assert.equal((await balance(s.c, s.dear)).value, 1000, "still untouched");
});

test("applying the same charge twice adds it once", async () => {
  const s = await receivedContainer();
  const cost = await landedCost(s, 240, "value");
  await applyLandedCost(s.c, String(cost.id));
  await applyLandedCost(s.c, String(cost.id));
  assert.equal((await balance(s.c, s.dear)).value, 1200);
});

test("a charge cannot be applied to a receipt that has not posted", async () => {
  const s = await receivedContainer();
  const qe = await getQueryEngine();
  await qe.patchComputed(s.c, "goodsReceipt", s.grn, { status: "draft" });
  const cost = await landedCost(s, 100, "value");
  await assert.rejects(() => applyLandedCost(s.c, String(cost.id)), /must be posted/);
});

test("voiding takes the value back out exactly", async () => {
  const s = await receivedContainer();
  const cost = await landedCost(s, 240, "value");
  await applyLandedCost(s.c, String(cost.id));

  const result = await voidLandedCost(s.c, String(cost.id));
  assert.equal(result.fromInventory, -240);
  assert.equal(result.fromCogs, 0);
  assert.equal((await balance(s.c, s.dear)).value, 1000, "back to the purchase price");
  assert.equal((await balance(s.c, s.dear)).avgCost, 10);
});

test("voiding after the goods are sold corrects COGS, never the shelf", async () => {
  // Nothing is left to take the freight back out of. Driving the balance
  // negative would be the defect the costing rebuild removed; the remainder
  // belongs against the cost of the goods that already left.
  const s = await receivedContainer();
  const cost = await landedCost(s, 240, "value");
  await applyLandedCost(s.c, String(cost.id));

  const inventory = await getInventoryService();
  for (const [productId, qty] of [[s.dear, 100], [s.cheap, 100]] as const) {
    await inventory.writeMovement(s.c, {
      productId,
      warehouseId: s.warehouse,
      qty: -qty,
      type: "issue",
      ref: `lc-clearout-${seq}`,
      refType: "invoice",
      movedAt: s.c.at,
    });
  }
  assert.equal((await balance(s.c, s.dear)).value, 0);

  const result = await voidLandedCost(s.c, String(cost.id));
  assert.equal(result.fromInventory, 0, "there was nothing on the shelf to reverse");
  assert.equal(result.fromCogs, -240, "so all of it corrects the cost of what was sold");
  assert.equal((await balance(s.c, s.dear)).value, 0, "and the balance never goes negative");
});

test("the stock ledger still explains every lira in the balance", async () => {
  // The invariant `inventory/reconcile` asserts: balance == sum(movement.value).
  // A value-only movement has to be part of that sum, or landed cost would show
  // up as unexplained drift.
  const s = await receivedContainer();
  const cost = await landedCost(s, 240, "value");
  await applyLandedCost(s.c, String(cost.id));

  const movements = await s.qe.listComplete(s.c, "stockMovement", {
    filters: [{ field: "productId", op: "eq", value: s.dear }],
  });
  const ledger = round2(movements.reduce((t, m) => t + Number(m.value ?? 0), 0));
  assert.equal(ledger, (await balance(s.c, s.dear)).value);

  const valueOnly = movements.find((m) => m.refType === "landedCost");
  assert.ok(valueOnly);
  assert.equal(Number(valueOnly.qty), 0, "value moved; no goods did");
  assert.equal(Number(valueOnly.value), 200);
});

// ---- supplier agreements -------------------------------------------------

test("a receipt records what was paid without touching the agreed price", async () => {
  const s = await receivedContainer();
  // The receipt above created the agreement from what was paid.
  const agreed = await priceFor(s.c, s.supplier, s.dear);
  assert.ok(agreed);
  assert.equal(Number(agreed.unitPrice), 10);
  assert.equal(Number(agreed.lastPurchasePrice), 10);

  // Negotiate it down, then receive at the old price anyway.
  await s.qe.patchComputed(s.c, "supplierProduct", String(agreed.id), { unitPrice: 8 });
  const pur = await getPurchasingService();
  const { doc: po } = await pur.createPO(
    s.c,
    { supplierId: s.supplier, warehouseId: s.warehouse, currencyCode: "TRY" },
    [{ productId: s.dear, description: "ikinci parti", qty: 10, unitPrice: 11, taxRate: 0 }],
  );
  await s.qe.patchComputed(s.c, "purchaseOrder", String(po.id), { status: "approved" });
  const { doc: grn } = await pur.createGRN(s.c, { poId: String(po.id), warehouseId: s.warehouse }, [
    { productId: s.dear, qty: 10, unitCost: 11 },
  ]);
  await pur.applyGRN(s.c, String(grn.id));

  const after = await priceFor(s.c, s.supplier, s.dear);
  assert.equal(Number(after?.unitPrice), 8, "the negotiated price is not overwritten by an invoice");
  assert.equal(Number(after?.lastPurchasePrice), 11, "and the discrepancy is visible");
});

test("an expired agreement is not in force", async () => {
  const s = await receivedContainer();
  const agreed = await priceFor(s.c, s.supplier, s.dear);
  assert.ok(agreed);
  await s.qe.patchComputed(s.c, "supplierProduct", String(agreed.id), {
    validFrom: "2020-01-01",
    validTo: "2020-12-31",
  });
  assert.equal(await priceFor(s.c, s.supplier, s.dear), null);
  // And it is in force on its last day.
  assert.ok(await priceFor(s.c, s.supplier, s.dear, "2020-12-31"));
});

test("suppliers are listed preferred first, then cheapest", async () => {
  const s = await receivedContainer();
  const qe = await getQueryEngine();
  const other = await qe.create(s.c, "supplier", { name: `LC Alternatif ${seq}` });
  const dearer = await qe.create(s.c, "supplier", { name: `LC Pahalı ${seq}` });
  await qe.createWithComputed(
    s.c,
    "supplierProduct",
    { supplierId: String(other.id), productId: s.dear, unitPrice: 6, active: true, preferred: false },
    { supplyKey: `${String(other.id)}:${s.dear}` },
  );
  await qe.createWithComputed(
    s.c,
    "supplierProduct",
    { supplierId: String(dearer.id), productId: s.dear, unitPrice: 99, active: true, preferred: true },
    { supplyKey: `${String(dearer.id)}:${s.dear}` },
  );

  const rows = await suppliersFor(s.c, s.dear);
  // Preferred leads even at 99: somebody chose it, and reliability and terms are
  // reasons this table does not model.
  assert.equal(String(rows[0]?.supplierId), String(dearer.id));
  assert.equal(String(rows[1]?.supplierId), String(other.id), "then cheapest");
});
