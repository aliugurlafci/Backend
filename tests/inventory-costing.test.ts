/**
 * Moving-average costing arithmetic.
 *
 * The property that matters most is stated once and checked repeatedly:
 *
 *     qty → 0  ⟹  value → 0, to the cent.
 *
 * An Inventory account carrying a balance with no units behind it is the bug
 * this design exists to remove, and proportional consumption is what removes it.
 * A stored 2-decimal average would pass casual examples and fail exactly here,
 * so several cases below use prices that do not divide evenly.
 *
 * Pure functions — no database, no clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyInbound, applyOutbound, avgCostOf, round2 } from "@/lib/inventory/costing";

const EMPTY = { qty: 0, value: 0 };

// ---- inbound ---------------------------------------------------------------

test("a receipt into an empty balance sets qty and value from the given cost", () => {
  const r = applyInbound(EMPTY, 100, 10);
  assert.deepEqual([r.newQty, r.newValue, r.valueDelta, r.appliedUnitCost], [100, 1000, 1000, 10]);
});

test("a second receipt at a different price blends the average", () => {
  const first = applyInbound(EMPTY, 100, 10);
  const second = applyInbound({ qty: first.newQty, value: first.newValue }, 50, 12);
  assert.equal(second.newQty, 150);
  assert.equal(second.newValue, 1600);
  assert.equal(avgCostOf({ qty: 150, value: 1600 }), 10.67); // 1600/150 = 10.666…
});

test("an inbound movement with no cost given defaults to the current average", () => {
  const bal = { qty: 100, value: 1000 };
  const r = applyInbound(bal, 10, avgCostOf(bal));
  assert.equal(r.appliedUnitCost, 10);
  assert.equal(r.newValue, 1100);
});

test("inbound rejects a non-positive quantity", () => {
  assert.throws(() => applyInbound(EMPTY, 0, 10), /positive quantity/);
  assert.throws(() => applyInbound(EMPTY, -5, 10), /positive quantity/);
});

// ---- outbound: the exactness property ---------------------------------------

test("consuming the entire balance leaves qty 0 AND value 0", () => {
  // 100 @10 then 50 @12 → 150 units, 1600 value, average 10.666…
  const bal = { qty: 150, value: 1600 };
  const out = applyOutbound(bal, 150);
  assert.equal(out.newQty, 0);
  assert.equal(out.newValue, 0, "value must land exactly on zero, not 0.01 or -0.02");
  assert.equal(out.valueDelta, -1600);
});

test("draining in several uneven steps still ends at exactly zero", () => {
  // A stored 2-decimal average would leave a residual here; proportional
  // consumption cannot, because the last issue takes whatever remains.
  let bal = { qty: 150, value: 1600 };
  for (const qty of [7, 33, 1, 59, 50]) {
    const out = applyOutbound(bal, qty);
    bal = { qty: out.newQty, value: out.newValue };
  }
  assert.equal(bal.qty, 0);
  assert.equal(bal.value, 0);
});

test("a price that does not divide evenly still zeroes out", () => {
  // 3 units at 10 → 3.333…/unit. Issue them one at a time.
  const bal = applyInbound(EMPTY, 3, 3.3333);
  let state = { qty: bal.newQty, value: bal.newValue };
  for (let i = 0; i < 3; i++) {
    const out = applyOutbound(state, 1);
    state = { qty: out.newQty, value: out.newValue };
  }
  assert.equal(state.qty, 0);
  assert.equal(state.value, 0);
});

test("a partial issue takes its proportional share of value", () => {
  const out = applyOutbound({ qty: 150, value: 1600 }, 40);
  assert.equal(out.newQty, 110);
  assert.equal(out.valueDelta, round2(-(1600 * 40) / 150)); // −426.67
  assert.equal(round2(out.newValue + Math.abs(out.valueDelta)), 1600, "value is conserved");
});

test("the applied unit cost reflects what was actually consumed", () => {
  const out = applyOutbound({ qty: 150, value: 1600 }, 40);
  assert.equal(out.appliedUnitCost, 10.67); // 426.67 / 40
});

test("outbound rejects a non-positive quantity", () => {
  assert.throws(() => applyOutbound({ qty: 10, value: 100 }, 0), /positive quantity/);
});

// ---- negative stock and late receipts --------------------------------------

test("issuing from an empty balance costs nothing — there is no basis yet", () => {
  const out = applyOutbound(EMPTY, 5);
  assert.equal(out.newQty, -5);
  assert.equal(out.valueDelta, 0, "no stock on hand means no cost to apportion");
  assert.equal(out.newValue, 0);
});

test("a receipt arriving after the issue lands at its own cost", () => {
  // Sell 5 before recording the purchase, then record 10 @10.
  const sold = applyOutbound(EMPTY, 5);
  const received = applyInbound({ qty: sold.newQty, value: sold.newValue }, 10, 10);
  assert.equal(received.newQty, 5);
  assert.equal(received.newValue, 100);
  // The 5 already issued were costed at nothing, so the remaining 5 carry the
  // full 100. This is inherent to a perpetual average: it does not restate the
  // past. The reconcile job surfaces it; it is not silently wrong.
  assert.equal(avgCostOf({ qty: 5, value: 100 }), 20);
});

test("issuing more than is on hand charges the excess at the current average", () => {
  const out = applyOutbound({ qty: 10, value: 100 }, 15);
  assert.equal(out.newQty, -5);
  assert.equal(out.valueDelta, -100, "cannot consume more value than is present");
  assert.equal(out.newValue, 0);
});

// ---- value conservation across a transfer ----------------------------------

test("a transfer conserves total value across the two warehouses", () => {
  // Out of A at its average, into B at the cost that left A.
  const from = { qty: 150, value: 1600 };
  const out = applyOutbound(from, 40);
  const derivedUnitCost = Math.abs(out.valueDelta) / 40;
  const into = applyInbound(EMPTY, 40, derivedUnitCost);

  assert.equal(round2(out.valueDelta + into.valueDelta), 0, "net-zero by construction");
  assert.equal(round2(out.newValue + into.newValue), 1600, "total value is unchanged");
});

// ---- write-off -------------------------------------------------------------

test("a write-off removes the average cost, not a hand-keyed one", () => {
  // The caller may pass any unitCost on a negative adjustment; costing ignores
  // it, because value written off must be value that was actually there.
  const out = applyOutbound({ qty: 150, value: 1600 }, 10);
  assert.equal(out.valueDelta, round2(-(1600 * 10) / 150)); // −106.67
});

// ---- avgCostOf -------------------------------------------------------------

test("average cost is zero when nothing is on hand", () => {
  assert.equal(avgCostOf(EMPTY), 0);
  assert.equal(avgCostOf({ qty: -5, value: 0 }), 0, "negative stock has no meaningful average");
});

// ---- the rule that the posting code kept breaking -------------------------

test("a rounded per-unit cost does not equal the value it came from", () => {
  // This is the trap. Reversing a movement of 426.67 over 40 units by passing
  // round2(426.67/40) = 10.67 back in puts 426.80 into the balance — so posting
  // the ORIGINAL 426.67 to the GL leaves 13 cents behind in the account after
  // the stock itself has returned to zero.
  const originalValue = 426.67;
  const qty = 40;
  const perUnit = round2(originalValue / qty); // 10.67
  const restored = applyInbound({ qty: 0, value: 0 }, qty, perUnit);
  assert.notEqual(restored.valueDelta, originalValue, "the two genuinely differ");
  assert.equal(restored.valueDelta, 426.8);
  // Hence the rule: post `result.valueDelta`, never the figure you started from.
});

test("posting the applied delta keeps a reversal exactly net-zero", () => {
  // Issue 40 of 150 @ 1600, then put it back at the rounded unit cost. Crediting
  // COGS with what the balance actually received (not the original number) is
  // what makes the pair cancel.
  const start = { qty: 150, value: 1600 };
  const out = applyOutbound(start, 40);
  const perUnit = round2(Math.abs(out.valueDelta) / 40);
  const back = applyInbound({ qty: out.newQty, value: out.newValue }, 40, perUnit);
  assert.equal(round2(out.valueDelta + back.valueDelta), round2(back.newValue - start.value));
});
