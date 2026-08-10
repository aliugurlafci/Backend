/**
 * The product model: pack barcodes and replenishment.
 *
 * Two things the catalogue could not previously express, both of which lost
 * stock rather than merely being inconvenient:
 *
 *  - **One barcode per product.** A bottle, a six-pack and a case each carry
 *    their own code. Scanning the case found nothing, so it was keyed in as one
 *    bottle — and eleven left the building unrecorded.
 *  - **`reorderLevel` and nothing else.** It could light a red badge. It could
 *    not say how much to buy, from whom, or whether the lead time meant today
 *    was already too late.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import type { RequestContext } from "@/lib/context/types";

const { getQueryEngine } = await import("@/lib/data/store");
const { systemContext } = await import("@/lib/context/resolver");
const { TENANT_ID, ORG_ID } = await import("@/lib/config/env");
const { getPosService } = await import("@/lib/pos/service");
const { getInventoryService } = await import("@/lib/inventory/service");
const { suggestReplenishment } = await import("@/lib/inventory/replenish");
const { reserve } = await import("@/lib/inventory/reservations");

const ctx = (): RequestContext => systemContext(TENANT_ID, ORG_ID);

let seq = 0;

/** A product sold by the piece, also carried by the case of twelve. */
async function packedProduct() {
  const qe = await getQueryEngine();
  const c = ctx();
  const n = ++seq;
  const piece = await qe.create(c, "uom", { code: `AD${n}`, name: "Adet", precision: 0 });
  const box = await qe.create(c, "uom", { code: `KL${n}`, name: "Koli", precision: 0 });
  const product = await qe.create(c, "product", {
    name: `Şişe ${n}`,
    sku: `PACK-${n}`,
    barcode: `869000000${String(n).padStart(4, "0")}`,
    unitPrice: 10,
    trackStock: true,
    baseUomId: String(piece.id),
  });
  await qe.create(c, "productUom", {
    conversionKey: `${String(product.id)}:${String(box.id)}`,
    productId: String(product.id),
    uomId: String(box.id),
    factor: 12,
    purpose: "both",
  });
  return { c, qe, product, piece, box, n };
}

test("a pack barcode resolves to the product AND to the pack unit", async () => {
  const s = await packedProduct();
  const caseCode = `869111100${String(s.n).padStart(4, "0")}`;
  await s.qe.create(s.c, "productBarcode", {
    productId: String(s.product.id),
    code: caseCode,
    barcodeType: "code128",
    uomId: String(s.box.id),
    label: "Koli",
  });

  const pos = await getPosService();
  const hit = await pos.scan(s.c, caseCode);
  assert.ok(hit);
  assert.equal(String(hit.product.id), String(s.product.id));
  // The unit is the point. Without it the case rings up as one bottle.
  assert.equal(hit.uomId, String(s.box.id));
});

test("the product's own barcode still means one base unit", async () => {
  const s = await packedProduct();
  const pos = await getPosService();
  const hit = await pos.scan(s.c, String(s.product.barcode));
  assert.ok(hit);
  assert.equal(String(hit.product.id), String(s.product.id));
  assert.equal(hit.uomId, null, "the primary barcode has always meant one, and must keep meaning one");
});

test("an unknown code resolves to nothing rather than to a guess", async () => {
  await packedProduct();
  const pos = await getPosService();
  assert.equal(await pos.scan(ctx(), "0000000000000"), null);
});

test("a pack barcode whose product is gone does not half-resolve", async () => {
  // A dangling alias row. Returning it would hand the till a barcode with no
  // product to price.
  const s = await packedProduct();
  const orphanCode = `869222200${String(s.n).padStart(4, "0")}`;
  await s.qe.create(s.c, "productBarcode", {
    productId: "999999",
    code: orphanCode,
    barcodeType: "code128",
  });
  const pos = await getPosService();
  assert.equal(await pos.scan(s.c, orphanCode), null);
});

test("scanning a case sells twelve pieces from the shelf", async () => {
  // The whole point of carrying the unit through: the ledger is only ever in
  // base units, so one case must leave as twelve.
  const s = await packedProduct();
  const caseCode = `869333300${String(s.n).padStart(4, "0")}`;
  await s.qe.create(s.c, "productBarcode", {
    productId: String(s.product.id),
    code: caseCode,
    uomId: String(s.box.id),
    barcodeType: "code128",
  });
  const warehouse = await s.qe.create(s.c, "warehouse", { name: `PW${s.n}`, code: `PW${s.n}` });
  const inventory = await getInventoryService();
  await inventory.writeMovement(s.c, {
    productId: String(s.product.id),
    warehouseId: String(warehouse.id),
    qty: 60,
    unitCost: 5,
    type: "receipt",
    ref: `pack-seed-${s.n}`,
    refType: "adjustment",
    movedAt: s.c.at,
  });

  const pos = await getPosService();
  const hit = await pos.scan(s.c, caseCode);
  assert.ok(hit);
  await pos.checkout(s.c, {
    warehouseId: String(warehouse.id),
    currencyCode: "TRY",
    lines: [
      { productId: String(hit.product.id), description: "1 koli", qty: 1, uomId: hit.uomId, unitPrice: 120, taxRate: 0 },
    ],
    payments: [{ method: "cash", amount: 120 }],
  });

  const balances = await s.qe.listComplete(s.c, "stockBalance", {
    filters: [{ field: "productId", op: "eq", value: String(s.product.id) }],
  });
  assert.equal(Number(balances[0]?.qty), 48, "sixty pieces less a case of twelve");
  assert.equal(Number(balances[0]?.value), 240, "cost follows the pieces: twelve at five");
});

// ---- replenishment -------------------------------------------------------

async function watched(opts: {
  onHand: number;
  reorderLevel: number;
  maxStock?: number;
  reorderQty?: number;
  leadTimeDays?: number;
  reserved?: number;
}) {
  const qe = await getQueryEngine();
  const c = ctx();
  const n = ++seq;
  const warehouse = await qe.create(c, "warehouse", { name: `RPW${n}`, code: `RPW${n}` });
  const supplier = await qe.create(c, "supplier", { name: `Tedarikçi ${n}` });
  const product = await qe.create(c, "product", {
    name: `İkmal ${n}`,
    sku: `RP-${n}`,
    unitPrice: 10,
    trackStock: true,
    active: true,
    reorderLevel: opts.reorderLevel,
    maxStock: opts.maxStock ?? null,
    reorderQty: opts.reorderQty ?? null,
    leadTimeDays: opts.leadTimeDays ?? null,
    preferredSupplierId: String(supplier.id),
  });
  if (opts.onHand > 0) {
    const inventory = await getInventoryService();
    await inventory.writeMovement(c, {
      productId: String(product.id),
      warehouseId: String(warehouse.id),
      qty: opts.onHand,
      unitCost: 5,
      type: "receipt",
      ref: `rp-seed-${n}`,
      refType: "adjustment",
      movedAt: c.at,
    });
  }
  if (opts.reserved) {
    await reserve(c, {
      productId: String(product.id),
      warehouseId: String(warehouse.id),
      qty: opts.reserved,
      refType: "salesOrderLine",
      refId: `rp-hold-${n}`,
    });
  }
  return { c, qe, product: String(product.id), warehouse: String(warehouse.id), supplier: String(supplier.id) };
}

const rowFor = async (c: RequestContext, productId: string) =>
  (await suggestReplenishment(c)).rows.find((r) => r.productId === productId);

test("a product above its reorder level is not proposed", async () => {
  const s = await watched({ onHand: 50, reorderLevel: 10 });
  assert.equal(await rowFor(s.c, s.product), undefined);
});

test("the suggestion fills back up to the max, not to the reorder level", async () => {
  // Filling to the reorder level leaves you one sale from ordering again.
  const s = await watched({ onHand: 8, reorderLevel: 10, maxStock: 100 });
  const row = await rowFor(s.c, s.product);
  assert.ok(row);
  assert.equal(row.suggestedQty, 92);
});

test("with no max, it proposes the least that clears the condition", async () => {
  const s = await watched({ onHand: 8, reorderLevel: 10 });
  const row = await rowFor(s.c, s.product);
  assert.equal(row?.suggestedQty, 2);
});

test("the order is rounded UP to the supplier's multiple", async () => {
  // Down would order less than the shortfall and re-raise the same suggestion
  // the week after the delivery lands.
  const s = await watched({ onHand: 8, reorderLevel: 10, maxStock: 50, reorderQty: 12 });
  const row = await rowFor(s.c, s.product);
  assert.equal(row?.suggestedQty, 48, "42 short, rounded up to four cases of twelve");
});

test("stock promised to an order is not counted as cover", async () => {
  // Twenty on the shelf with eighteen promised is two. Buying against the twenty
  // is how the order that promised them ships late.
  const s = await watched({ onHand: 20, reorderLevel: 10, maxStock: 30, reserved: 18 });
  const row = await rowFor(s.c, s.product);
  assert.ok(row, "available (2) is below the level of 10, so it must be proposed");
  assert.equal(row.onHand, 20);
  assert.equal(row.reserved, 18);
  assert.equal(row.available, 2);
  assert.equal(row.suggestedQty, 28);
});

test("nothing free at all is critical; a lead time on a low line is urgent", async () => {
  const empty = await watched({ onHand: 0, reorderLevel: 5, maxStock: 20 });
  assert.equal((await rowFor(empty.c, empty.product))?.urgency, "critical");

  const slow = await watched({ onHand: 4, reorderLevel: 5, maxStock: 20, leadTimeDays: 30 });
  assert.equal((await rowFor(slow.c, slow.product))?.urgency, "urgent");
});

test("the preferred supplier travels with the suggestion", async () => {
  const s = await watched({ onHand: 1, reorderLevel: 5, maxStock: 10 });
  const row = await rowFor(s.c, s.product);
  assert.equal(row?.supplierId, s.supplier);
  assert.ok(row?.supplierName?.startsWith("Tedarikçi"));
});

test("a product with no reorder level is never proposed", async () => {
  // A reorder level is a decision somebody made. Without one there is nothing to
  // say how much of this we mean to hold.
  const s = await watched({ onHand: 0, reorderLevel: 0 });
  assert.equal(await rowFor(s.c, s.product), undefined);
});
