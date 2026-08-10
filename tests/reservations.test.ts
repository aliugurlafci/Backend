/**
 * Holding stock for a document that has not shipped.
 *
 * Sellable stock WAS on-hand stock, so two salespeople could both read "one
 * left", both promise it, and neither find out until one tried to ship — by
 * which point both customers had a delivery date.
 *
 * The property everything else serves: `available = qty - reserved`, enforced
 * at the point of reserving under a row lock. Enforced anywhere else it is a
 * check two callers can pass at the same moment, which is the bug.
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
const { reserve, release, availability, expireReservations } = await import("@/lib/inventory/reservations");

const ctx = (): RequestContext => systemContext(TENANT_ID, ORG_ID);

let seq = 0;
/** A product with `onHand` units on the shelf, unreserved. */
async function stocked(onHand: number) {
  const qe = await getQueryEngine();
  const n = ++seq;
  const warehouse = await qe.create(ctx(), "warehouse", { name: `RW${n}`, code: `RW${n}` });
  const product = await qe.create(ctx(), "product", { name: `Ürün ${n}`, sku: `RES-${n}`, unitPrice: 10, trackStock: true });
  const inventory = await getInventoryService();
  await inventory.writeMovement(ctx(), {
    productId: String(product.id),
    warehouseId: String(warehouse.id),
    qty: onHand,
    unitCost: 10,
    type: "receipt",
    ref: `seed-${n}`,
    refType: "adjustment",
    movedAt: ctx().at,
  });
  return { product: String(product.id), warehouse: String(warehouse.id) };
}

const avail = (s: { product: string; warehouse: string }) => availability(ctx(), s.product, s.warehouse);

test("reserving reduces what is available without touching what is on hand", async () => {
  const s = await stocked(10);
  await reserve(ctx(), { productId: s.product, warehouseId: s.warehouse, qty: 4, refType: "salesOrder", refId: "SO-1" });
  const a = await avail(s);
  assert.equal(a.onHand, 10, "the goods are still on the shelf");
  assert.equal(a.reserved, 4);
  assert.equal(a.available, 6, "but only six can still be promised");
});

test("THE case: the second seller cannot promise the last unit", async () => {
  // One unit, two salespeople. Without a reservation both are told yes.
  const s = await stocked(1);
  await reserve(ctx(), { productId: s.product, warehouseId: s.warehouse, qty: 1, refType: "salesOrder", refId: "SO-A" });
  await assert.rejects(
    () => reserve(ctx(), { productId: s.product, warehouseId: s.warehouse, qty: 1, refType: "salesOrder", refId: "SO-B" }),
    /insufficient available stock/,
  );
  assert.equal((await avail(s)).available, 0);
});

test("the error says what is on hand AND what is held", async () => {
  // "Insufficient stock" against a shelf that visibly has ten on it reads as a
  // bug in the system. Naming the hold is what makes it actionable.
  const s = await stocked(10);
  await reserve(ctx(), { productId: s.product, warehouseId: s.warehouse, qty: 8, refType: "cart", refId: "C-1" });
  await assert.rejects(
    () => reserve(ctx(), { productId: s.product, warehouseId: s.warehouse, qty: 5, refType: "cart", refId: "C-2" }),
    /2 available \(10 on hand, 8 reserved\)/,
  );
});

test("re-reserving the same document REPLACES its hold rather than adding to it", async () => {
  // "Save the order again" must be safe. Adding instead would double the hold,
  // and the quantity nobody releases is invisible until the warehouse reports
  // less available than it has.
  const s = await stocked(10);
  await reserve(ctx(), { productId: s.product, warehouseId: s.warehouse, qty: 3, refType: "salesOrder", refId: "SO-R" });
  await reserve(ctx(), { productId: s.product, warehouseId: s.warehouse, qty: 3, refType: "salesOrder", refId: "SO-R" });
  assert.equal((await avail(s)).reserved, 3, "held once, not twice");
});

test("growing a hold asks only for the difference", async () => {
  // Raising 3 to 5 needs two more units, not five. Requiring five would refuse
  // an order the warehouse can actually fill.
  const s = await stocked(6);
  await reserve(ctx(), { productId: s.product, warehouseId: s.warehouse, qty: 3, refType: "salesOrder", refId: "SO-G" });
  await reserve(ctx(), { productId: s.product, warehouseId: s.warehouse, qty: 5, refType: "salesOrder", refId: "SO-G" });
  const a = await avail(s);
  assert.equal(a.reserved, 5);
  assert.equal(a.available, 1);
});

test("shrinking a hold gives the difference back", async () => {
  const s = await stocked(10);
  await reserve(ctx(), { productId: s.product, warehouseId: s.warehouse, qty: 8, refType: "salesOrder", refId: "SO-S" });
  await reserve(ctx(), { productId: s.product, warehouseId: s.warehouse, qty: 2, refType: "salesOrder", refId: "SO-S" });
  assert.equal((await avail(s)).available, 8);
});

test("releasing returns the stock to the sellable pool", async () => {
  const s = await stocked(5);
  await reserve(ctx(), { productId: s.product, warehouseId: s.warehouse, qty: 5, refType: "cart", refId: "C-X" });
  assert.equal((await avail(s)).available, 0);
  assert.equal(await release(ctx(), "cart", "C-X"), 1);
  assert.equal((await avail(s)).available, 5);
});

test("releasing a document that holds nothing is not an error", async () => {
  // Cancelling an order that never reserved is ordinary, and a throw here would
  // fail the cancellation.
  assert.equal(await release(ctx(), "salesOrder", "never-existed"), 0);
});

test("shipping consumes the hold, so the units are not subtracted twice", async () => {
  // The issue already reduced `qty`. If the hold stayed, `available` would
  // subtract the same units again and the shelf would look emptier than it is.
  const s = await stocked(10);
  await reserve(ctx(), { productId: s.product, warehouseId: s.warehouse, qty: 4, refType: "salesOrder", refId: "SO-SHIP" });

  const inventory = await getInventoryService();
  await inventory.writeMovement(ctx(), {
    productId: s.product,
    warehouseId: s.warehouse,
    qty: -4,
    type: "issue",
    ref: "SO-SHIP",
    refType: "invoice",
    movedAt: ctx().at,
  });
  await release(ctx(), "salesOrder", "SO-SHIP", "consumed");

  const a = await avail(s);
  assert.equal(a.onHand, 6, "four left the shelf");
  assert.equal(a.reserved, 0, "and the hold went with them");
  assert.equal(a.available, 6, "not two");
});

test("a reservation cannot be made against stock that does not exist", async () => {
  const qe = await getQueryEngine();
  const n = ++seq;
  const warehouse = await qe.create(ctx(), "warehouse", { name: `NW${n}`, code: `NW${n}` });
  const product = await qe.create(ctx(), "product", { name: `Yok ${n}`, sku: `NON-${n}`, unitPrice: 1, trackStock: true });
  await assert.rejects(
    () => reserve(ctx(), { productId: String(product.id), warehouseId: String(warehouse.id), qty: 1, refType: "cart", refId: "C-0" }),
    /no stock on hand/,
  );
});

test("a non-positive reservation is refused", async () => {
  // Zero holds nothing and negative would hand out stock that was never there.
  const s = await stocked(5);
  for (const qty of [0, -1]) {
    await assert.rejects(
      () => reserve(ctx(), { productId: s.product, warehouseId: s.warehouse, qty, refType: "cart", refId: `C-${qty}` }),
      /positive quantity/,
    );
  }
});

test("an expired hold is given back", async () => {
  // A quote nobody followed up would otherwise hold stock for ever, and the only
  // symptom is a warehouse reporting less available than it has — which reads as
  // a stock problem rather than a stale document.
  const s = await stocked(5);
  await reserve(ctx(), {
    productId: s.product,
    warehouseId: s.warehouse,
    qty: 5,
    refType: "quote",
    refId: "Q-OLD",
    expiresAt: "2020-01-01T00:00:00.000Z",
  });
  assert.equal((await avail(s)).available, 0);
  assert.equal(await expireReservations(ctx()), 1);
  assert.equal((await avail(s)).available, 5);
});

test("a hold that has not expired is left alone", async () => {
  const s = await stocked(5);
  await reserve(ctx(), {
    productId: s.product,
    warehouseId: s.warehouse,
    qty: 5,
    refType: "quote",
    refId: "Q-NEW",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  await expireReservations(ctx());
  assert.equal((await avail(s)).available, 0, "still held");
});

test("holds from different documents accumulate", async () => {
  const s = await stocked(10);
  await reserve(ctx(), { productId: s.product, warehouseId: s.warehouse, qty: 3, refType: "salesOrder", refId: "SO-1" });
  await reserve(ctx(), { productId: s.product, warehouseId: s.warehouse, qty: 4, refType: "cart", refId: "C-1" });
  const a = await avail(s);
  assert.equal(a.reserved, 7);
  assert.equal(a.available, 3);
  // Releasing one leaves the other alone.
  await release(ctx(), "cart", "C-1");
  assert.equal((await avail(s)).reserved, 3);
});

test("availability of a product with no balance row is zero, not an error", async () => {
  // Every screen asks this before it has anything to show.
  const a = await availability(ctx(), "999999", "999999");
  assert.deepEqual(a, { onHand: 0, reserved: 0, available: 0 });
});

test("an ordering filter never matches a null — the same as SQL", async () => {
  // `compare` puts null lowest so SORTING matches both engines; reusing that for
  // a FILTER made `expiresAt < now` true for every row with no expiry, so the
  // sweep released exactly the reservations that were set never to lapse. SQL's
  // three-valued logic excludes them, and the in-memory adapter must agree or
  // the bug only appears in production.
  const qe = await getQueryEngine();
  const s = await stocked(5);
  await reserve(ctx(), { productId: s.product, warehouseId: s.warehouse, qty: 1, refType: "quote", refId: "Q-NULL" });

  const lapsed = await qe.listComplete(ctx(), "stockReservation", {
    filters: [
      { field: "refId", op: "eq", value: "Q-NULL" },
      { field: "expiresAt", op: "lt", value: "2099-01-01T00:00:00.000Z" },
    ],
  });
  assert.equal(lapsed.length, 0, "a hold with no expiry is not 'before' any date");
});
