/**
 * Receiving against a purchase order line.
 *
 * The case that broke everything was the same product on an order TWICE — a
 * price change mid-negotiation, or two delivery batches at different rates.
 * Matching by product merged them: the outstanding quantities became one bucket,
 * the second line's price overwrote the first as the default cost, and
 * `qtyReceived` could not be attributed to either line.
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

const ctx = (): RequestContext => systemContext(TENANT_ID, ORG_ID);

let seq = 0;
/** A PO with the same product on two lines at different prices, approved. */
async function twoLineOrder() {
  const qe = await getQueryEngine();
  const c = ctx();
  const run = ++seq;
  const pur = await getPurchasingService();

  const warehouse = await qe.create(c, "warehouse", { name: `W${run}`, code: `W${run}` });
  const supplier = await qe.create(c, "supplier", { name: `S${run}` });
  const product = await qe.create(c, "product", { name: `P${run}`, sku: `SKU${run}`, unitPrice: 100, trackStock: true });

  const { doc: po } = await pur.createPO(
    c,
    { supplierId: String(supplier.id), warehouseId: String(warehouse.id), currencyCode: "TRY" },
    [
      { productId: String(product.id), description: "first batch", qty: 10, unitPrice: 60, taxRate: 0 },
      { productId: String(product.id), description: "second batch", qty: 5, unitPrice: 65, taxRate: 0 },
    ],
  );
  await qe.patchComputed(c, "purchaseOrder", String(po.id), { status: "approved" });

  const lines = (
    await qe.listComplete(c, "purchaseOrderLine", { filters: [{ field: "poId", op: "eq", value: String(po.id) }] })
  ).sort((a, b) => Number(a.id) - Number(b.id));

  return { c, qe, pur, po, warehouse, supplier, product, cheap: lines[0], dear: lines[1] };
}

const poLines = async (c: RequestContext, poId: string) => {
  const qe = await getQueryEngine();
  return (await qe.listComplete(c, "purchaseOrderLine", { filters: [{ field: "poId", op: "eq", value: poId }] }))
    .sort((a, b) => Number(a.id) - Number(b.id));
};

test("a receipt is attributed to the line it names", async () => {
  // Against the SECOND line deliberately. Receiving against the first proves
  // nothing: a product-keyed tally spreads oldest-first, so it would land on the
  // first line too and give the same answer for the wrong reason.
  const s = await twoLineOrder();
  const { doc: grn } = await s.pur.createGRN(
    s.c,
    { poId: String(s.po.id), warehouseId: String(s.warehouse.id) },
    [{ poLineId: String(s.dear!.id), productId: String(s.product.id), qty: 5, unitCost: 65 }],
  );
  await s.pur.applyGRN(s.c, String(grn.id));

  const [cheap, dear] = await poLines(s.c, String(s.po.id));
  assert.equal(Number(dear!.qtyReceived), 5, "the line named on the receipt");
  assert.equal(Number(cheap!.qtyReceived), 0, "the other line must not absorb any of it");
});

test("the cost defaults from THAT line, not whichever was read last", async () => {
  // The old map was keyed by product, so the second line's price overwrote the
  // first — receiving the first ten was silently valued at 65.
  const s = await twoLineOrder();
  const { doc: grn } = await s.pur.createGRN(
    s.c,
    { poId: String(s.po.id), warehouseId: String(s.warehouse.id) },
    [{ poLineId: String(s.dear!.id), productId: String(s.product.id), qty: 5 }],
  );
  const lines = await s.qe.listComplete(s.c, "goodsReceiptLine", {
    filters: [{ field: "grnId", op: "eq", value: String(grn.id) }],
  });
  assert.equal(Number(lines[0]!.unitCost), 65);
  assert.equal(String(lines[0]!.poLineId), String(s.dear!.id));
});

test("receiving more than a line ordered is refused", async () => {
  const s = await twoLineOrder();
  await assert.rejects(
    () =>
      s.pur.createGRN(
        s.c,
        { poId: String(s.po.id), warehouseId: String(s.warehouse.id) },
        [{ poLineId: String(s.dear!.id), productId: String(s.product.id), qty: 6 }],
      ),
    /exceeds the outstanding/,
  );
});

test("two receipt rows for one product do not both spend the same outstanding", async () => {
  // Each row is checked against what is left AFTER the rows before it, not
  // against the untouched figure — otherwise two rows of 10 against a line of 10
  // would both pass.
  const s = await twoLineOrder();
  await assert.rejects(
    () =>
      s.pur.createGRN(
        s.c,
        { poId: String(s.po.id), warehouseId: String(s.warehouse.id) },
        [
          { poLineId: String(s.cheap!.id), productId: String(s.product.id), qty: 10 },
          { poLineId: String(s.cheap!.id), productId: String(s.product.id), qty: 10 },
        ],
      ),
    /exceeds the outstanding/,
  );
});

test("without a line id, the oldest open line is filled first", async () => {
  // The fallback for callers that only know the barcode. Oldest first because a
  // PO's lines are in the order they were negotiated — and the read is SORTED,
  // because an unsorted one returns whatever order the database chose and duly
  // picked the wrong line.
  const s = await twoLineOrder();
  const { doc: grn } = await s.pur.createGRN(
    s.c,
    { poId: String(s.po.id), warehouseId: String(s.warehouse.id) },
    [{ productId: String(s.product.id), qty: 4 }],
  );
  const lines = await s.qe.listComplete(s.c, "goodsReceiptLine", {
    filters: [{ field: "grnId", op: "eq", value: String(grn.id) }],
  });
  assert.equal(Number(lines[0]!.unitCost), 60, "the first line's price, not the second's");
  assert.equal(String(lines[0]!.poLineId), String(s.cheap!.id));
});

test("a product not on the order is refused", async () => {
  const s = await twoLineOrder();
  const other = await s.qe.create(s.c, "product", { name: `X${seq}`, sku: `X${seq}`, unitPrice: 1, trackStock: true });
  await assert.rejects(
    () =>
      s.pur.createGRN(
        s.c,
        { poId: String(s.po.id), warehouseId: String(s.warehouse.id) },
        [{ productId: String(other.id), qty: 1 }],
      ),
    /not on purchase order/,
  );
});

test("receiving both lines closes the order", async () => {
  const s = await twoLineOrder();
  for (const [line, qty] of [[s.cheap, 10], [s.dear, 5]] as const) {
    const { doc: grn } = await s.pur.createGRN(
      s.c,
      { poId: String(s.po.id), warehouseId: String(s.warehouse.id) },
      [{ poLineId: String(line!.id), productId: String(s.product.id), qty }],
    );
    await s.pur.applyGRN(s.c, String(grn.id));
  }
  const po = await s.qe.get(s.c, "purchaseOrder", String(s.po.id));
  assert.equal(po.status, "received");
  const [cheap, dear] = await poLines(s.c, String(s.po.id));
  assert.equal(Number(cheap!.qtyReceived), 10);
  assert.equal(Number(dear!.qtyReceived), 5);
});

test("applying a receipt twice does not double the stock", async () => {
  // `applyGRN` is reachable from both the bespoke route and the lifecycle event,
  // so it has to be idempotent on its own rather than relying on a status check
  // that the lifecycle has already changed.
  const s = await twoLineOrder();
  const { doc: grn } = await s.pur.createGRN(
    s.c,
    { poId: String(s.po.id), warehouseId: String(s.warehouse.id) },
    [{ poLineId: String(s.cheap!.id), productId: String(s.product.id), qty: 10 }],
  );
  await s.pur.applyGRN(s.c, String(grn.id));
  await s.pur.applyGRN(s.c, String(grn.id));

  const balances = await s.qe.listComplete(s.c, "stockBalance", {
    filters: [{ field: "productId", op: "eq", value: String(s.product.id) }],
  });
  assert.equal(Number(balances[0]?.qty), 10, "posted twice, received once");
});
