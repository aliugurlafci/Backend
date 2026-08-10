/**
 * Unit-of-measure conversion.
 *
 * The catalogue held a free-text `uom` string defaulting to "ea" — fine for
 * printing on a label, useless for anything else. Buying by the case and selling
 * by the piece, which is how a distributor ordinarily works, was not expressible
 * at all.
 *
 * One invariant carries the whole feature: the stock ledger is ALWAYS in base
 * units. A balance that mixes cases and pieces cannot be valued — what is the
 * average cost of "3"? — cannot be picked and cannot be counted, and nothing
 * about it looks wrong until somebody stands in front of the shelf.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import type { RequestContext } from "@/lib/context/types";

const { getQueryEngine } = await import("@/lib/data/store");
const { systemContext } = await import("@/lib/context/resolver");
const { TENANT_ID, ORG_ID } = await import("@/lib/config/env");
const { toBase, fromBase, isRepresentable, roundToUnit, loadFactors, lineQtyInBase } = await import("@/lib/inventory/uom");

const ctx = (): RequestContext => systemContext(TENANT_ID, ORG_ID);

let seq = 0;
/** A product sold by the piece and bought by the twelve. */
async function distributorProduct() {
  const qe = await getQueryEngine();
  const n = ++seq;
  const piece = await qe.create(ctx(), "uom", { code: `EA${n}`, name: "Adet", decimals: 0 });
  const box = await qe.create(ctx(), "uom", { code: `KOLI${n}`, name: "Koli", decimals: 0 });
  const kg = await qe.create(ctx(), "uom", { code: `KG${n}`, name: "Kilogram", decimals: 3 });
  const product = await qe.create(ctx(), "product", {
    name: `Vida ${n}`,
    sku: `UOM-${n}`,
    unitPrice: 10,
    trackStock: true,
    baseUomId: String(piece.id),
  });
  await qe.create(ctx(), "productUom", {
    conversionKey: `${String(product.id)}:${String(box.id)}`,
    productId: String(product.id),
    uomId: String(box.id),
    factor: 12,
    purpose: "purchase",
  });
  return { product, piece, box, kg };
}

// ---- the arithmetic --------------------------------------------------------

test("a case converts to its pieces", () => {
  assert.equal(toBase(3, 12), 36);
  assert.equal(fromBase(36, 12), 3);
});

test("conversion round-trips", () => {
  for (const [qty, factor] of [[7, 12], [1, 6], [2.5, 4], [100, 1]] as const) {
    assert.equal(fromBase(toBase(qty, factor), factor), qty, `${qty} × ${factor}`);
  }
});

test("a zero or negative factor is refused, not applied", () => {
  // A zero factor converts every quantity to no stock at all; a negative one
  // turns a receipt into an issue. Both corrupt the ledger silently.
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => toBase(5, bad), /factor must be positive/, String(bad));
  }
});

test("a non-numeric quantity is refused", () => {
  assert.throws(() => toBase(Number.NaN, 12), /quantity must be a number/);
});

// ---- precision -------------------------------------------------------------

test("half a piece is not a quantity; half a kilo is", () => {
  // 2.5 pieces produces a balance nobody can pick and a count that can never
  // agree. 2.5 kg is ordinary. The unit is what says which.
  assert.equal(isRepresentable(2.5, 0), false, "pieces");
  assert.equal(isRepresentable(2.5, 3), true, "kilograms");
  assert.equal(isRepresentable(3, 0), true);
  assert.equal(isRepresentable(0.001, 3), true);
  assert.equal(isRepresentable(0.0001, 3), false, "beyond the unit's precision");
});

test("rounding respects the unit", () => {
  assert.equal(roundToUnit(2.6, 0), 3);
  assert.equal(roundToUnit(2.4449, 3), 2.445);
});

test("floating point does not make a whole number look fractional", () => {
  // 0.1 + 0.2 is 0.30000000000000004. Without a tolerance this reports a
  // perfectly ordinary quantity as unrepresentable.
  assert.equal(isRepresentable(0.1 + 0.2, 3), true);
  assert.equal(isRepresentable(toBase(0.1, 3), 3), true);
});

// ---- against the catalogue -------------------------------------------------

test("the base unit is factor 1 without anyone storing it", async () => {
  // A stored row for the base unit invites somebody to edit it, which would
  // rescale the product's entire history.
  const s = await distributorProduct();
  const { factors, baseUomId } = await loadFactors(ctx(), String(s.product.id));
  assert.equal(baseUomId, String(s.piece.id));
  assert.equal(factors.get(String(s.piece.id)), 1);
  assert.equal(factors.get(String(s.box.id)), 12);
});

test("a conversion row claiming to redefine the base unit is ignored", async () => {
  const s = await distributorProduct();
  const qe = await getQueryEngine();
  await qe.create(ctx(), "productUom", {
    conversionKey: `${String(s.product.id)}:${String(s.piece.id)}`,
    productId: String(s.product.id),
    uomId: String(s.piece.id),
    factor: 99,
    purpose: "both",
  });
  const { factors } = await loadFactors(ctx(), String(s.product.id));
  assert.equal(factors.get(String(s.piece.id)), 1, "the base unit is 1 by definition");
});

test("a line in cases reaches the ledger in pieces", async () => {
  // THE point of the feature. Three cases of twelve is thirty-six pieces in
  // stock, and the balance is only ever in pieces.
  const s = await distributorProduct();
  assert.equal(await lineQtyInBase(ctx(), String(s.product.id), 3, String(s.box.id)), 36);
});

test("a line with no unit is already in base units", async () => {
  // What every line written before this existed means, and what a line still
  // means for a product with no alternative units. This fallback is why
  // introducing the feature changes nothing for a catalogue that has not
  // adopted it.
  const s = await distributorProduct();
  assert.equal(await lineQtyInBase(ctx(), String(s.product.id), 5, null), 5);
  assert.equal(await lineQtyInBase(ctx(), String(s.product.id), 5, undefined), 5);
});

test("a line in the base unit converts to itself", async () => {
  const s = await distributorProduct();
  assert.equal(await lineQtyInBase(ctx(), String(s.product.id), 5, String(s.piece.id)), 5);
});

test("an unknown unit is REFUSED, not assumed to be one", async () => {
  // Assuming a factor of 1 would book twelve cases as twelve pieces — a
  // shortfall of eleven twelfths that surfaces weeks later as a stock
  // discrepancy nobody can explain.
  const s = await distributorProduct();
  await assert.rejects(
    () => lineQtyInBase(ctx(), String(s.product.id), 3, String(s.kg.id)),
    /no conversion for the selected unit/,
  );
});

test("a product with no base unit passes quantities through untouched", async () => {
  // The whole existing catalogue. Nothing about it changes until a base unit is
  // set on the product.
  const qe = await getQueryEngine();
  const legacy = await qe.create(ctx(), "product", { name: "Legacy", sku: `LEG-${++seq}`, unitPrice: 1, trackStock: true });
  assert.equal(await lineQtyInBase(ctx(), String(legacy.id), 7, null), 7);
});

// ---- end to end: a case sold is pieces issued -------------------------------

test("selling one case issues twelve pieces from stock", async () => {
  // The whole feature, stated once. The line says "1", the customer receives a
  // case, and the ledger records twelve pieces leaving — because a balance that
  // counts cases cannot be reconciled against a shelf that holds pieces.
  const s = await distributorProduct();
  const qe = await getQueryEngine();
  const { getInventoryService } = await import("@/lib/inventory/service");
  const { getFinanceService } = await import("@/lib/finance/service");
  const { postInvoiceGL } = await import("@/lib/accounting/postings");

  const warehouse = await qe.create(ctx(), "warehouse", { name: `W${seq}`, code: `WU${seq}` });
  const account = await qe.create(ctx(), "account", { name: `Müşteri ${seq}` });
  const inventory = await getInventoryService();
  // 60 pieces on the shelf, received at 10 each.
  await inventory.writeMovement(ctx(), {
    productId: String(s.product.id),
    warehouseId: String(warehouse.id),
    qty: 60,
    unitCost: 10,
    type: "receipt",
    ref: "seed",
    refType: "adjustment",
    movedAt: ctx().at,
  });

  const finance = await getFinanceService();
  const invoice = await finance.createDocument(ctx(), "invoice", "INV", {
    accountId: String(account.id),
    warehouseId: String(warehouse.id),
    status: "draft",
    issueDate: "2026-08-09",
  });
  // ONE case.
  await finance.replaceLines(ctx(), "invoice", "invoiceLine", "invoiceId", invoice.id, [
    { productId: String(s.product.id), description: "Bir koli vida", qty: 1, unitPrice: 180, taxRate: 0, uomId: String(s.box.id) },
  ]);

  const lines = await qe.listComplete(ctx(), "invoiceLine", {
    filters: [{ field: "invoiceId", op: "eq", value: invoice.id }],
  });
  assert.equal(Number(lines[0]?.qty), 1, "the line still says one case");
  assert.equal(Number(lines[0]?.qtyBase), 12, "and records twelve pieces");

  await postInvoiceGL(ctx(), invoice.id);

  const balances = await qe.listComplete(ctx(), "stockBalance", {
    filters: [{ field: "productId", op: "eq", value: String(s.product.id) }],
  });
  assert.equal(Number(balances[0]?.qty), 48, "sixty pieces less a case of twelve");
  // Cost follows the pieces, not the case: twelve at ten.
  assert.equal(Number(balances[0]?.value), 480);
});

test("a receipt in cases lands as pieces too", async () => {
  const s = await distributorProduct();
  const qe = await getQueryEngine();
  const { getPurchasingService } = await import("@/lib/purchasing/service");
  const warehouse = await qe.create(ctx(), "warehouse", { name: `WR${seq}`, code: `WR${seq}` });
  const supplier = await qe.create(ctx(), "supplier", { name: `Tedarikçi ${seq}` });
  const pur = await getPurchasingService();

  const { doc: po } = await pur.createPO(
    ctx(),
    { supplierId: String(supplier.id), warehouseId: String(warehouse.id), currencyCode: "TRY" },
    [{ productId: String(s.product.id), description: "2 koli", qty: 2, unitPrice: 120, taxRate: 0, uomId: String(s.box.id) }],
  );
  await qe.patchComputed(ctx(), "purchaseOrder", String(po.id), { status: "approved" });

  const { doc: grn } = await pur.createGRN(
    ctx(),
    { poId: String(po.id), warehouseId: String(warehouse.id) },
    [{ productId: String(s.product.id), qty: 2, unitCost: 120 }],
  );
  await pur.applyGRN(ctx(), String(grn.id));

  const balances = await qe.listComplete(ctx(), "stockBalance", {
    filters: [{ field: "productId", op: "eq", value: String(s.product.id) }],
  });
  assert.equal(Number(balances[0]?.qty), 24, "two cases of twelve");
});
