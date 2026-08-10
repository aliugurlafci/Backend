/**
 * Lot / parti tracking: picking, expiry, and the recall question.
 *
 * Three things the ledger could not answer:
 *
 *  - "Lot 2026-A is contaminated; who has it?" — answerable only if the ISSUE
 *    recorded the lot as well as the receipt.
 *  - "What expires this month?" — and the warning has to come BEFORE the date,
 *    because afterwards the goods are already a write-off.
 *  - "Which box should the picker take?" — left to a person it is whichever is
 *    nearest the door, so the oldest stock stays at the back until it expires.
 *
 * The compatibility property that makes all of this safe: a product that does
 * NOT track lots keeps one balance row per warehouse, a two-part `stockKey`, and
 * every code path it had before.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import type { RequestContext } from "@/lib/context/types";

const { getQueryEngine } = await import("@/lib/data/store");
const { systemContext } = await import("@/lib/context/resolver");
const { TENANT_ID, ORG_ID } = await import("@/lib/config/env");
const { getInventoryService, stockKeyOf } = await import("@/lib/inventory/service");
const { allocateFefo, fefoOrder, ensureLot, lotStock, pickLots, traceLot, expireLots } = await import(
  "@/lib/inventory/lots"
);

const ctx = (): RequestContext => systemContext(TENANT_ID, ORG_ID);

// ---- the picking order, with no database in sight ------------------------

const lot = (over: Partial<Parameters<typeof fefoOrder>[0][number]>) => ({
  lotId: "1",
  lotNumber: "L1",
  expiryDate: null,
  status: "active",
  qty: 10,
  reserved: 0,
  available: 10,
  ...over,
});

test("the batch that expires soonest is picked first, not the one that arrived first", () => {
  // FEFO, not FIFO. A later delivery with a shorter remaining life is more
  // urgent than an older one with a year left.
  const order = fefoOrder([
    lot({ lotId: "1", lotNumber: "old", expiryDate: "2027-01-01" }),
    lot({ lotId: "2", lotNumber: "new", expiryDate: "2026-03-01" }),
  ]);
  assert.deepEqual(order.map((l) => l.lotNumber), ["new", "old"]);
});

test("dated batches go before undated ones", () => {
  // A dated lot is on a clock; an undated one is not.
  const order = fefoOrder([
    lot({ lotId: "1", lotNumber: "undated", expiryDate: null }),
    lot({ lotId: "2", lotNumber: "dated", expiryDate: "2030-01-01" }),
  ]);
  assert.deepEqual(order.map((l) => l.lotNumber), ["dated", "undated"]);
});

test("undated batches fall back to oldest first", () => {
  const order = fefoOrder([
    lot({ lotId: "7", lotNumber: "later" }),
    lot({ lotId: "3", lotNumber: "earlier" }),
  ]);
  assert.deepEqual(order.map((l) => l.lotNumber), ["earlier", "later"]);
});

test("a quantity is split across batches in picking order", () => {
  const { allocations, shortfall } = allocateFefo(
    [
      lot({ lotId: "1", lotNumber: "A", expiryDate: "2026-02-01", available: 4 }),
      lot({ lotId: "2", lotNumber: "B", expiryDate: "2026-05-01", available: 10 }),
    ],
    9,
  );
  assert.equal(shortfall, 0);
  assert.deepEqual(
    allocations.map((a) => [a.lotNumber, a.qty]),
    [
      ["A", 4],
      ["B", 5],
    ],
  );
});

test("a shortfall is reported, not thrown", () => {
  // What a shortfall MEANS is the caller's decision: refuse the order, or ship
  // what there is and back-order the rest. A function that decides can only
  // give the first answer.
  const { allocations, shortfall } = allocateFefo([lot({ available: 3 })], 10);
  assert.equal(allocations[0]?.qty, 3);
  assert.equal(shortfall, 7);
});

test("reserved stock is not allocated", () => {
  const { shortfall } = allocateFefo([lot({ qty: 10, reserved: 8, available: 2 })], 5);
  assert.equal(shortfall, 3);
});

// ---- against the real ledger ---------------------------------------------

let seq = 0;

/** A lot-tracked product with two batches in one warehouse. */
async function batched() {
  const qe = await getQueryEngine();
  const c = ctx();
  const n = ++seq;
  const warehouse = await qe.create(c, "warehouse", { name: `LTW${n}`, code: `LTW${n}` });
  const supplier = await qe.create(c, "supplier", { name: `LT Tedarikçi ${n}` });
  const account = await qe.create(c, "account", { name: `LT Müşteri ${n}` });
  const product = await qe.create(c, "product", {
    name: `Süt ${n}`,
    sku: `LT-${n}`,
    unitPrice: 20,
    trackStock: true,
    trackLots: true,
  });
  return { c, qe, warehouse: String(warehouse.id), supplier: String(supplier.id), account: String(account.id), product: String(product.id), n };
}

/** Receive `qty` of a batch expiring on `expiry`, at `cost`. */
async function receive(
  s: Awaited<ReturnType<typeof batched>>,
  lotNumber: string,
  qty: number,
  expiry: string | null,
  cost = 10,
) {
  const row = await ensureLot(s.c, {
    productId: s.product,
    lotNumber,
    expiryDate: expiry,
    supplierId: s.supplier,
  });
  const inventory = await getInventoryService();
  await inventory.writeMovement(s.c, {
    productId: s.product,
    warehouseId: s.warehouse,
    lotId: String(row.id),
    qty,
    unitCost: cost,
    type: "receipt",
    ref: `lt-${s.n}-${lotNumber}`,
    refType: "goodsReceipt",
    movedAt: s.c.at,
  });
  return String(row.id);
}

test("each batch gets its own balance, keyed by lot", async () => {
  const s = await batched();
  const a = await receive(s, "2026-A", 100, "2026-03-01");
  const b = await receive(s, "2026-B", 50, "2026-06-01");

  const balances = await s.qe.listComplete(s.c, "stockBalance", {
    filters: [{ field: "productId", op: "eq", value: s.product }],
  });
  assert.equal(balances.length, 2, "two batches, two balances");
  const keys = balances.map((x) => String(x.stockKey)).sort();
  assert.deepEqual(keys, [stockKeyOf(s.product, s.warehouse, a), stockKeyOf(s.product, s.warehouse, b)].sort());
});

test("an untracked product keeps ONE balance and its two-part key", async () => {
  // The whole compatibility story: turning lots on for one product cannot
  // change anything about the rest of the catalogue.
  const s = await batched();
  const plain = await s.qe.create(s.c, "product", {
    name: `Vida ${s.n}`,
    sku: `LT-P${s.n}`,
    unitPrice: 1,
    trackStock: true,
    trackLots: false,
  });
  const inventory = await getInventoryService();
  for (const i of [1, 2]) {
    await inventory.writeMovement(s.c, {
      productId: String(plain.id),
      warehouseId: s.warehouse,
      qty: 10,
      unitCost: 1,
      type: "receipt",
      ref: `lt-plain-${s.n}-${i}`,
      refType: "goodsReceipt",
      movedAt: s.c.at,
    });
  }
  const balances = await s.qe.listComplete(s.c, "stockBalance", {
    filters: [{ field: "productId", op: "eq", value: String(plain.id) }],
  });
  assert.equal(balances.length, 1);
  assert.equal(String(balances[0]?.stockKey), stockKeyOf(String(plain.id), s.warehouse));
  assert.equal(balances[0]?.lotId ?? null, null);
  assert.equal(Number(balances[0]?.qty), 20);
});

test("each batch carries its own cost, so lot valuation needed no new engine", async () => {
  const s = await batched();
  await receive(s, "ucuz", 100, "2026-06-01", 10);
  await receive(s, "pahalı", 100, "2026-03-01", 14);

  const balances = await s.qe.listComplete(s.c, "stockBalance", {
    filters: [{ field: "productId", op: "eq", value: s.product }],
  });
  const costs = balances.map((b) => Number(b.avgCost)).sort((a, b) => a - b);
  assert.deepEqual(costs, [10, 14], "not blended into a single 12");
});

test("picking takes the batch that expires soonest", async () => {
  const s = await batched();
  await receive(s, "geç", 100, "2026-12-01");
  const soon = await receive(s, "yakın", 40, "2026-03-01");

  const picks = await pickLots(s.c, s.product, s.warehouse, 30);
  assert.equal(picks.length, 1);
  assert.equal(picks[0]?.lotId, soon);
  assert.equal(picks[0]?.qty, 30);
});

test("picking spills into the next batch when the first runs out", async () => {
  const s = await batched();
  const soon = await receive(s, "yakın", 40, "2026-03-01");
  const late = await receive(s, "geç", 100, "2026-12-01");

  const picks = await pickLots(s.c, s.product, s.warehouse, 60);
  assert.deepEqual(
    picks.map((p) => [p.lotId, p.qty]),
    [
      [soon, 40],
      [late, 20],
    ],
  );
});

test("picking more than the batches hold is refused", async () => {
  const s = await batched();
  await receive(s, "tek", 10, "2026-03-01");
  await assert.rejects(() => pickLots(s.c, s.product, s.warehouse, 25), /insufficient pickable stock/);
});

test("a quarantined batch is on hand and valued, but not pickable", async () => {
  // Physically there and still worth money — reporting it as absent is how a
  // stocktake fails. It simply cannot be shipped.
  const s = await batched();
  const held = await receive(s, "karantina", 100, "2026-12-01");
  await s.qe.patchComputed(s.c, "stockLot", held, { status: "quarantined" });

  const pickable = await lotStock(s.c, s.product, s.warehouse);
  assert.equal(pickable.length, 0);

  const all = await lotStock(s.c, s.product, s.warehouse, { includeUnpickable: true });
  assert.equal(all.length, 1);
  assert.equal(all[0]?.qty, 100, "still on the shelf");
  assert.equal(all[0]?.available, 0, "but nothing can be taken from it");

  await assert.rejects(() => pickLots(s.c, s.product, s.warehouse, 1), /insufficient pickable stock/);
});

test("receiving the same batch twice adds to it rather than splitting it in two", async () => {
  // A split delivery, or a re-posted receipt. Two rows with the same lot number
  // would divide one batch in two and make a recall find half of it.
  const s = await batched();
  const first = await receive(s, "2026-A", 100, "2026-03-01");
  const second = await receive(s, "2026-A", 50, "2026-03-01");
  assert.equal(first, second, "the same lot");

  const lots = await s.qe.listComplete(s.c, "stockLot", {
    filters: [{ field: "productId", op: "eq", value: s.product }],
  });
  assert.equal(lots.length, 1);
});

test("an expiry is proposed from the product's shelf life when none is stated", async () => {
  const s = await batched();
  await s.qe.patchComputed(s.c, "product", s.product, { shelfLifeDays: 10 });
  const row = await ensureLot(s.c, {
    productId: s.product,
    lotNumber: `shelf-${s.n}`,
    manufacturedDate: "2026-01-01",
  });
  assert.equal(String(row.expiryDate), "2026-01-11");
});

test("the date on the box beats the shelf life", async () => {
  const s = await batched();
  await s.qe.patchComputed(s.c, "product", s.product, { shelfLifeDays: 10 });
  const row = await ensureLot(s.c, {
    productId: s.product,
    lotNumber: `printed-${s.n}`,
    manufacturedDate: "2026-01-01",
    expiryDate: "2026-02-20",
  });
  assert.equal(String(row.expiryDate), "2026-02-20");
});

test("a batch past its date becomes unpickable; the stock stays valued", async () => {
  const s = await batched();
  const stale = await receive(s, "eski", 100, "2020-01-01");
  const swept = await expireLots(s.c);
  assert.ok(swept >= 1);

  assert.equal(String((await s.qe.get(s.c, "stockLot", stale)).status), "expired");
  const all = await lotStock(s.c, s.product, s.warehouse, { includeUnpickable: true });
  assert.equal(all[0]?.qty, 100, "still physically there");
  assert.equal(all[0]?.available, 0);
});

test("a batch with no expiry is never swept", async () => {
  // The memory and SQL adapters agree that `NULL < x` is false — the same
  // NULL semantics the reservation expiry sweep depends on.
  const s = await batched();
  const undated = await receive(s, "tarihsiz", 10, null);
  await expireLots(s.c);
  assert.equal(String((await s.qe.get(s.c, "stockLot", undated)).status), "active");
});

test("a batch expiring today is still good", async () => {
  const s = await batched();
  const today = await receive(s, "bugün", 10, s.c.at.slice(0, 10));
  await expireLots(s.c);
  assert.equal(String((await s.qe.get(s.c, "stockLot", today)).status), "active");
});

test("the trace answers where a batch came from and who received it", async () => {
  // The recall question.
  const s = await batched();
  const lotId = await receive(s, "2026-RECALL", 100, "2026-12-01");

  const inventory = await getInventoryService();
  await inventory.writeMovement(s.c, {
    productId: s.product,
    warehouseId: s.warehouse,
    lotId,
    qty: -30,
    type: "issue",
    ref: `lt-out-${s.n}`,
    refType: "deliveryNote",
    movedAt: s.c.at,
  });

  const trace = await traceLot(s.c, lotId);
  assert.equal(trace.onHand, 70);
  assert.equal(trace.inbound.length, 1);
  assert.equal(trace.outbound.length, 1);
  assert.equal(trace.inbound[0]?.refType, "goodsReceipt");
  assert.equal(trace.outbound[0]?.refType, "deliveryNote");
  assert.equal(trace.outbound[0]?.qty, -30);
});

test("two batches of the same product on one document both move", async () => {
  // `writeMovement` is idempotent on (ref, refType, product, warehouse, type)
  // — the LOT had to join that key, or a delivery drawing on three batches
  // would have two thirds of it come back as a duplicate and never leave.
  const s = await batched();
  const a = await receive(s, "A", 40, "2026-03-01");
  const b = await receive(s, "B", 40, "2026-06-01");

  const inventory = await getInventoryService();
  for (const [lotId, qty] of [[a, 40], [b, 20]] as const) {
    await inventory.writeMovement(s.c, {
      productId: s.product,
      warehouseId: s.warehouse,
      lotId,
      qty: -qty,
      type: "issue",
      ref: `lt-multi-${s.n}`,
      refType: "deliveryNote",
      movedAt: s.c.at,
    });
  }

  const balances = await s.qe.listComplete(s.c, "stockBalance", {
    filters: [{ field: "productId", op: "eq", value: s.product }],
  });
  const total = balances.reduce((t, x) => t + Number(x.qty ?? 0), 0);
  assert.equal(total, 20, "sixty left the building, not forty");
});

test("reconciliation explains lot-keyed balances", async () => {
  // The ledger aggregation had to group by LOT as well. Grouping only by
  // (product, warehouse) compares one total against several balances and
  // reports every batch as drift.
  const s = await batched();
  await receive(s, "A", 40, "2026-03-01", 10);
  await receive(s, "B", 60, "2026-06-01", 12);

  const { reconcileStockBalances } = await import("@/lib/inventory/reconcile");
  const result = await reconcileStockBalances(s.c, { apply: false, productId: s.product });
  assert.deepEqual(result.drifted, []);
});

test("a reservation header row is not reported as drift", async () => {
  // A lot-tracked product holds its reservations on a (product, warehouse) row
  // that carries no stock — the goods live in the per-lot rows. Expecting the
  // ledger to explain a zero it never wrote would report the product as broken.
  const s = await batched();
  await receive(s, "A", 40, "2026-03-01");
  const { reserve } = await import("@/lib/inventory/reservations");
  await reserve(s.c, {
    productId: s.product,
    warehouseId: s.warehouse,
    qty: 10,
    refType: "salesOrderLine",
    refId: `lt-hold-${s.n}`,
  });

  const header = await s.qe.listComplete(s.c, "stockBalance", {
    filters: [{ field: "stockKey", op: "eq", value: stockKeyOf(s.product, s.warehouse) }],
  });
  assert.equal(header.length, 1, "the header exists");
  assert.equal(Number(header[0]?.qty), 0, "and holds no stock");
  assert.equal(Number(header[0]?.reservedQty), 10, "only the promise");

  const { reconcileStockBalances } = await import("@/lib/inventory/reconcile");
  const result = await reconcileStockBalances(s.c, { apply: false, productId: s.product });
  assert.deepEqual(result.drifted, []);
});

test("a promise is made against the product, not against a batch", async () => {
  // Which box goes out is decided when somebody picks it — and by then a
  // shorter-dated batch may have arrived.
  const s = await batched();
  await receive(s, "A", 40, "2026-03-01");
  await receive(s, "B", 60, "2026-06-01");

  const { availability, reserve } = await import("@/lib/inventory/reservations");
  let a = await availability(s.c, s.product, s.warehouse);
  assert.equal(a.onHand, 100, "summed across both batches");
  assert.equal(a.available, 100);

  await reserve(s.c, {
    productId: s.product,
    warehouseId: s.warehouse,
    qty: 70,
    refType: "salesOrderLine",
    refId: `lt-promise-${s.n}`,
  });
  a = await availability(s.c, s.product, s.warehouse);
  assert.equal(a.reserved, 70);
  assert.equal(a.available, 30, "a promise spanning two batches is still one promise");
});
