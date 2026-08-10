/**
 * The middle of the sales chain: order → delivery note → invoice.
 *
 * The chain ran `deal → quote → invoice`, which works only when everything is
 * quoted, agreed and shipped in one step. What a distributor actually does —
 * take an order now, ship it in two loads over three weeks, invoice what left —
 * had nowhere to live.
 *
 * The three properties under test, each of which was a way to lose stock:
 *
 *  - confirming an order HOLDS the stock, so a second order cannot promise it;
 *  - goods leave on the DELIVERY NOTE, at cost, not on the invoice weeks later;
 *  - fulfilment is tracked per ORDER LINE, so the same product at two prices
 *    stays two separate promises.
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
const { availability } = await import("@/lib/inventory/reservations");
const {
  confirmOrder,
  createDelivery,
  createOrder,
  applyDelivery,
  voidDelivery,
  orderFulfilment,
  releaseOrder,
  convertQuoteToOrder,
  convertDeliveryToInvoice,
} = await import("@/lib/sales/orders");

const ctx = (): RequestContext => systemContext(TENANT_ID, ORG_ID);

let seq = 0;

/** A warehouse holding `onHand` of one product, bought at `cost`. */
async function stocked(onHand: number, cost = 10) {
  const qe = await getQueryEngine();
  const c = ctx();
  const n = ++seq;
  const warehouse = await qe.create(c, "warehouse", { name: `SOW${n}`, code: `SOW${n}` });
  const account = await qe.create(c, "account", { name: `Müşteri ${n}` });
  const product = await qe.create(c, "product", {
    name: `Ürün ${n}`,
    sku: `SO-${n}`,
    unitPrice: 100,
    trackStock: true,
  });
  const inventory = await getInventoryService();
  await inventory.writeMovement(c, {
    productId: String(product.id),
    warehouseId: String(warehouse.id),
    qty: onHand,
    unitCost: cost,
    type: "receipt",
    ref: `so-seed-${n}`,
    refType: "adjustment",
    movedAt: c.at,
  });
  return {
    c,
    qe,
    warehouse: String(warehouse.id),
    account: String(account.id),
    product: String(product.id),
  };
}

const balanceOf = async (c: RequestContext, product: string, warehouse: string) => {
  const qe = await getQueryEngine();
  const page = await qe.list(c, "stockBalance", {
    filters: [{ field: "stockKey", op: "eq", value: `${product}:${warehouse}` }],
    pageSize: 1,
  });
  const row = page.items[0];
  return { qty: Number(row?.qty ?? 0), value: Number(row?.value ?? 0) };
};

test("confirming an order holds its stock; nothing is held while it is a draft", async () => {
  const s = await stocked(100);
  const order = await createOrder(
    s.c,
    { accountId: s.account, warehouseId: s.warehouse, currencyCode: "TRY" },
    [{ productId: s.product, description: "Sipariş", qty: 40, unitPrice: 100, taxRate: 20 }],
  );

  // A draft is still being edited. Holding stock for it would let an abandoned
  // order starve the ones somebody means to ship.
  let a = await availability(s.c, s.product, s.warehouse);
  assert.equal(a.reserved, 0);
  assert.equal(a.available, 100);

  await confirmOrder(s.c, String(order.id));

  a = await availability(s.c, s.product, s.warehouse);
  assert.equal(a.onHand, 100, "confirming promises stock; it does not move it");
  assert.equal(a.reserved, 40);
  assert.equal(a.available, 60);
});

test("an order that cannot be covered is refused, and stays a draft", async () => {
  const s = await stocked(5);
  const order = await createOrder(
    s.c,
    { accountId: s.account, warehouseId: s.warehouse, currencyCode: "TRY" },
    [{ productId: s.product, description: "Fazla", qty: 9, unitPrice: 100, taxRate: 0 }],
  );

  await assert.rejects(() => confirmOrder(s.c, String(order.id)), /insufficient available stock/);

  // The status must NOT have moved. Told it is confirmed, a salesperson gives
  // the customer a date — which is the failure reservations exist to prevent.
  const after = await s.qe.get(s.c, "salesOrder", String(order.id));
  assert.equal(after.status, "draft");
  const a = await availability(s.c, s.product, s.warehouse);
  assert.equal(a.reserved, 0, "a failed confirmation leaves nothing held");
});

test("a partial delivery issues stock at cost and leaves the rest outstanding", async () => {
  const s = await stocked(100, 10);
  const order = await createOrder(
    s.c,
    { accountId: s.account, warehouseId: s.warehouse, currencyCode: "TRY" },
    [{ productId: s.product, description: "Sipariş", qty: 40, unitPrice: 100, taxRate: 0 }],
  );
  await confirmOrder(s.c, String(order.id));

  const note = await createDelivery(
    s.c,
    String(order.id),
    { carrierName: "Aras", vehiclePlate: "34 ABC 123" },
    [{ productId: s.product, qty: 25 }],
  );
  const cost = await applyDelivery(s.c, String(note.id));

  // Goods leave HERE, weeks before the invoice. A system that issues stock only
  // when it invoices reports delivered goods as still on the shelf.
  const bal = await balanceOf(s.c, s.product, s.warehouse);
  assert.equal(bal.qty, 75);
  assert.equal(bal.value, 750);
  assert.equal(cost, 250, "costed from the balance average, not the selling price");

  const f = await orderFulfilment(s.c, String(order.id));
  assert.equal(f.salesOrder.status, "partial");
  assert.equal(f.lines[0]?.qtyShipped, 25);
  assert.equal(f.lines[0]?.outstanding, 15);

  // The hold SHRINKS to what is still owed rather than being dropped: the rest
  // of the line has not shipped and still needs its stock kept back.
  const a = await availability(s.c, s.product, s.warehouse);
  assert.equal(a.reserved, 15);
  assert.equal(a.available, 60);
});

test("the second load closes the order and consumes the last of the hold", async () => {
  const s = await stocked(100, 10);
  const order = await createOrder(
    s.c,
    { accountId: s.account, warehouseId: s.warehouse, currencyCode: "TRY" },
    [{ productId: s.product, description: "Sipariş", qty: 40, unitPrice: 100, taxRate: 0 }],
  );
  await confirmOrder(s.c, String(order.id));

  const first = await createDelivery(s.c, String(order.id), {}, [{ productId: s.product, qty: 25 }]);
  await applyDelivery(s.c, String(first.id));
  const second = await createDelivery(s.c, String(order.id), {}, [{ productId: s.product, qty: 15 }]);
  await applyDelivery(s.c, String(second.id));

  const f = await orderFulfilment(s.c, String(order.id));
  assert.equal(f.salesOrder.status, "shipped");
  assert.equal(f.lines[0]?.outstanding, 0);

  const bal = await balanceOf(s.c, s.product, s.warehouse);
  assert.equal(bal.qty, 60);

  const a = await availability(s.c, s.product, s.warehouse);
  assert.equal(a.reserved, 0, "consumed — the issue already took the units out");
  assert.equal(a.available, 60);
});

test("shipping more than the line still owes is refused", async () => {
  const s = await stocked(100);
  const order = await createOrder(
    s.c,
    { accountId: s.account, warehouseId: s.warehouse, currencyCode: "TRY" },
    [{ productId: s.product, description: "Sipariş", qty: 10, unitPrice: 100, taxRate: 0 }],
  );
  await confirmOrder(s.c, String(order.id));

  await assert.rejects(
    () => createDelivery(s.c, String(order.id), {}, [{ productId: s.product, qty: 11 }]),
    /exceeds/,
  );
});

test("the same product on two order lines stays two separate promises", async () => {
  // The defect class this whole design is arranged around: matching on the
  // product collapses two lines into one bucket, so the shipped quantity cannot
  // be attributed and the price comes from whichever line was read last.
  const s = await stocked(100, 10);
  const order = await createOrder(
    s.c,
    { accountId: s.account, warehouseId: s.warehouse, currencyCode: "TRY" },
    [
      { productId: s.product, description: "Kampanyalı", qty: 10, unitPrice: 80, taxRate: 0 },
      { productId: s.product, description: "Liste fiyatı", qty: 10, unitPrice: 100, taxRate: 0 },
    ],
  );
  await confirmOrder(s.c, String(order.id));

  const f0 = await orderFulfilment(s.c, String(order.id));
  const cheapLine = String(f0.lines[0]?.orderLineId);
  const dearLine = String(f0.lines[1]?.orderLineId);

  // Named explicitly — ship the DEAR line, leaving the cheap one untouched.
  const note = await createDelivery(s.c, String(order.id), {}, [
    { orderLineId: dearLine, productId: s.product, qty: 10 },
  ]);
  await applyDelivery(s.c, String(note.id));

  const f = await orderFulfilment(s.c, String(order.id));
  const byId = new Map(f.lines.map((l) => [l.orderLineId, l]));
  assert.equal(byId.get(cheapLine)?.qtyShipped, 0, "the untouched line must not absorb the shipment");
  assert.equal(byId.get(dearLine)?.qtyShipped, 10);
  assert.equal(f.salesOrder.status, "partial");

  // And the note is priced from the line it filled, not from the other one.
  const lines = await s.qe.listComplete(s.c, "deliveryNoteLine", {
    filters: [{ field: "noteId", op: "eq", value: String(note.id) }],
  });
  assert.equal(Number(lines[0]?.unitPrice), 100);
});

test("one note carrying the same product twice issues BOTH quantities", async () => {
  // `writeMovement` is idempotent on (ref, refType, product, warehouse, type),
  // so without collapsing the second line came back as a duplicate of the first
  // and its stock never left. Twenty units shipped, ten deducted.
  const s = await stocked(100, 10);
  const order = await createOrder(
    s.c,
    { accountId: s.account, warehouseId: s.warehouse, currencyCode: "TRY" },
    [
      { productId: s.product, description: "Kampanyalı", qty: 10, unitPrice: 80, taxRate: 0 },
      { productId: s.product, description: "Liste fiyatı", qty: 10, unitPrice: 100, taxRate: 0 },
    ],
  );
  await confirmOrder(s.c, String(order.id));

  const f0 = await orderFulfilment(s.c, String(order.id));
  const note = await createDelivery(s.c, String(order.id), {}, [
    { orderLineId: String(f0.lines[0]?.orderLineId), productId: s.product, qty: 10 },
    { orderLineId: String(f0.lines[1]?.orderLineId), productId: s.product, qty: 10 },
  ]);
  const cost = await applyDelivery(s.c, String(note.id));

  const bal = await balanceOf(s.c, s.product, s.warehouse);
  assert.equal(bal.qty, 80, "both lines left the building");
  assert.equal(cost, 200);

  // One movement, not two — collapsed, which is what keeps idempotency intact.
  const movements = await s.qe.listComplete(s.c, "stockMovement", {
    filters: [
      { field: "ref", op: "eq", value: String(note.id) },
      { field: "refType", op: "eq", value: "deliveryNote" },
    ],
  });
  assert.equal(movements.length, 1);
  assert.equal(Number(movements[0]?.qty), -20);
});

test("dispatching the same note twice does not issue the stock twice", async () => {
  const s = await stocked(100, 10);
  const order = await createOrder(
    s.c,
    { accountId: s.account, warehouseId: s.warehouse, currencyCode: "TRY" },
    [{ productId: s.product, description: "Sipariş", qty: 10, unitPrice: 100, taxRate: 0 }],
  );
  await confirmOrder(s.c, String(order.id));
  const note = await createDelivery(s.c, String(order.id), {}, [{ productId: s.product, qty: 10 }]);

  await applyDelivery(s.c, String(note.id));
  await applyDelivery(s.c, String(note.id));

  const bal = await balanceOf(s.c, s.product, s.warehouse);
  assert.equal(bal.qty, 90, "the retry is a no-op, not a second issue");
});

test("voiding a dispatched note puts the goods back at the value that left", async () => {
  const s = await stocked(100, 10);
  const order = await createOrder(
    s.c,
    { accountId: s.account, warehouseId: s.warehouse, currencyCode: "TRY" },
    [{ productId: s.product, description: "Sipariş", qty: 20, unitPrice: 100, taxRate: 0 }],
  );
  await confirmOrder(s.c, String(order.id));
  const note = await createDelivery(s.c, String(order.id), {}, [{ productId: s.product, qty: 20 }]);
  await applyDelivery(s.c, String(note.id));

  const restored = await voidDelivery(s.c, String(note.id));
  assert.equal(restored, 200);

  // Exactly where it started — a void whose only job is to undo a post must
  // undo it to the kuruş.
  const bal = await balanceOf(s.c, s.product, s.warehouse);
  assert.equal(bal.qty, 100);
  assert.equal(bal.value, 1000);

  // And the order owes the goods again, held for it.
  const f = await orderFulfilment(s.c, String(order.id));
  assert.equal(f.lines[0]?.qtyShipped, 0);
  assert.equal(f.salesOrder.status, "confirmed");
  const a = await availability(s.c, s.product, s.warehouse);
  assert.equal(a.reserved, 20);
});

test("a draft note has nothing to void", async () => {
  const s = await stocked(50);
  const order = await createOrder(
    s.c,
    { accountId: s.account, warehouseId: s.warehouse, currencyCode: "TRY" },
    [{ productId: s.product, description: "Sipariş", qty: 5, unitPrice: 100, taxRate: 0 }],
  );
  await confirmOrder(s.c, String(order.id));
  const note = await createDelivery(s.c, String(order.id), {}, [{ productId: s.product, qty: 5 }]);

  assert.equal(await voidDelivery(s.c, String(note.id)), 0);
  const bal = await balanceOf(s.c, s.product, s.warehouse);
  assert.equal(bal.qty, 50, "nothing had left, so nothing comes back");
});

test("cancelling an order gives its stock back", async () => {
  const s = await stocked(30);
  const order = await createOrder(
    s.c,
    { accountId: s.account, warehouseId: s.warehouse, currencyCode: "TRY" },
    [{ productId: s.product, description: "Sipariş", qty: 30, unitPrice: 100, taxRate: 0 }],
  );
  await confirmOrder(s.c, String(order.id));
  assert.equal((await availability(s.c, s.product, s.warehouse)).available, 0);

  await releaseOrder(s.c, String(order.id));
  assert.equal((await availability(s.c, s.product, s.warehouse)).available, 30);
});

test("a note is priced from the order, and a pro-rated discount is not applied twice", async () => {
  const s = await stocked(100, 10);
  const order = await createOrder(
    s.c,
    { accountId: s.account, warehouseId: s.warehouse, currencyCode: "TRY" },
    // 100 lira off a line of 10 units. Copied whole onto two loads of 5 it would
    // be given twice.
    [{ productId: s.product, description: "Sipariş", qty: 10, unitPrice: 100, discountAmount: 100, taxRate: 0 }],
  );
  await confirmOrder(s.c, String(order.id));

  const first = await createDelivery(s.c, String(order.id), {}, [{ productId: s.product, qty: 5 }]);
  await applyDelivery(s.c, String(first.id));
  const second = await createDelivery(s.c, String(order.id), {}, [{ productId: s.product, qty: 5 }]);
  await applyDelivery(s.c, String(second.id));

  // 5 × 100 − 50 = 450 on each load; 900 across both, which is the order's
  // 1000 − 100 exactly.
  assert.equal(Number(first.total), 450);
  assert.equal(Number((await s.qe.get(s.c, "deliveryNote", String(second.id))).total), 450);
});

test("invoicing a dispatched note bills the load without issuing the stock again", async () => {
  const s = await stocked(100, 10);
  const order = await createOrder(
    s.c,
    { accountId: s.account, warehouseId: s.warehouse, currencyCode: "TRY" },
    [{ productId: s.product, description: "Sipariş", qty: 40, unitPrice: 100, taxRate: 20 }],
  );
  await confirmOrder(s.c, String(order.id));
  const note = await createDelivery(s.c, String(order.id), {}, [{ productId: s.product, qty: 25 }]);
  await s.qe.patchComputed(s.c, "deliveryNote", String(note.id), { status: "posted" });
  await applyDelivery(s.c, String(note.id));

  const invoiceId = await convertDeliveryToInvoice(s.c, String(note.id));
  const invoice = await s.qe.get(s.c, "invoice", invoiceId);

  // Billed for what LEFT — 25, not the 40 ordered. That is the whole reason the
  // two documents are separate.
  assert.equal(Number(invoice.subtotal), 2500);
  assert.equal(Number(invoice.total), 3000);

  // And the note now names the invoice, which is what stops the COGS posting
  // issuing these units a second time.
  const linked = await s.qe.get(s.c, "deliveryNote", String(note.id));
  assert.equal(String(linked.invoiceId), invoiceId);

  // Calling it again hands back the same invoice rather than raising a second.
  assert.equal(await convertDeliveryToInvoice(s.c, String(note.id)), invoiceId);
});

test("a quote becomes a draft order carrying its lines and discounts", async () => {
  const s = await stocked(100);
  const finance = await (await import("@/lib/finance/service")).getFinanceService();
  const quote = await finance.createDocument(s.c, "quote", "Q", {
    accountId: s.account,
    currencyCode: "TRY",
    status: "draft",
  });
  await finance.replaceLines(s.c, "quote", "quoteLine", "quoteId", String(quote.id), [
    { productId: s.product, description: "Teklif", qty: 6, unitPrice: 100, taxRate: 20, discountRate: 10 },
  ]);

  const orderId = await convertQuoteToOrder(s.c, String(quote.id));
  const order = await s.qe.get(s.c, "salesOrder", orderId);
  const lines = await s.qe.listComplete(s.c, "salesOrderLine", {
    filters: [{ field: "orderId", op: "eq", value: orderId }],
  });

  // A draft: confirming is a separate, deliberate act, because that is what
  // holds the stock.
  assert.equal(order.status, "draft");
  assert.equal(String(order.quoteId), String(quote.id));
  assert.equal(lines.length, 1);
  assert.equal(Number(lines[0]?.discountRate), 10, "the agreed discount survives the conversion");
  assert.equal(Number(order.total), 648); // 600 − 10% = 540, +20% KDV
});
