/**
 * Collapsing a document's lines into one movement per stock key.
 *
 * The bug this exists to close: `writeMovement` is idempotent on
 * `(ref, refType, product, warehouse, type)`, so a DOCUMENT could not produce
 * two movements with the same key — the second came back as a duplicate of the
 * first and its quantity never reached the shelf. An invoice listing the same
 * product on two lines (one discounted, one not) charged for both and issued
 * one.
 *
 * The property that makes collapsing safe: the value applied must be identical
 * to what line-by-line would have applied. That is why the cost is weighted by
 * quantity and not simply averaged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { collapseMovementLines } from "@/lib/inventory/movement-lines";

test("two lines of the same product become one movement", () => {
  const out = collapseMovementLines([
    { productId: "p1", warehouseId: "w1", qtyBase: 3 },
    { productId: "p1", warehouseId: "w1", qtyBase: 5 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.qtyBase, 8);
});

test("the same product in two warehouses stays two movements", () => {
  // Different balance rows entirely — collapsing these would move stock between
  // warehouses out of nowhere.
  const out = collapseMovementLines([
    { productId: "p1", warehouseId: "w1", qtyBase: 3 },
    { productId: "p1", warehouseId: "w2", qtyBase: 5 },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((l) => [l.warehouseId, l.qtyBase]),
    [
      ["w1", 3],
      ["w2", 5],
    ],
  );
});

test("cost is weighted by quantity, so the value added is unchanged", () => {
  // 5 @ 10 plus 5 @ 12 must add 110 — which a plain average of the two costs
  // also gives, so use an uneven split where the two answers differ.
  const out = collapseMovementLines([
    { productId: "p1", warehouseId: "w1", qtyBase: 9, unitCost: 10 },
    { productId: "p1", warehouseId: "w1", qtyBase: 1, unitCost: 20 },
  ]);
  const line = out[0];
  assert.ok(line);
  assert.equal(line.qtyBase, 10);
  assert.equal(line.unitCost, 11); // (9×10 + 1×20) / 10 — not (10+20)/2 = 15
  assert.equal(line.qtyBase * line.unitCost, 110);
});

test("a line with no cost contributes zero value, not a skipped weighting", () => {
  const out = collapseMovementLines([
    { productId: "p1", warehouseId: "w1", qtyBase: 1, unitCost: 100 },
    { productId: "p1", warehouseId: "w1", qtyBase: 1 },
  ]);
  assert.equal(out[0]?.unitCost, 50);
});

test("the weighted cost is not pre-rounded, so no value is created or lost", () => {
  // 10 @ 60 + 5 @ 80 = 1000 exactly. Rounding the average to kuruş first gives
  // 66.67, and 15 × 66.67 = 1000.05 — five kuruş of stock out of nowhere.
  // `applyInbound` rounds the product, so this must not round the factor.
  const out = collapseMovementLines([
    { productId: "p1", warehouseId: "w1", qtyBase: 10, unitCost: 60 },
    { productId: "p1", warehouseId: "w1", qtyBase: 5, unitCost: 80 },
  ]);
  const line = out[0];
  assert.ok(line);
  assert.equal(Math.round(line.qtyBase * line.unitCost * 100) / 100, 1000);
});

test("zero-quantity lines are dropped rather than written as empty movements", () => {
  const out = collapseMovementLines([
    { productId: "p1", warehouseId: "w1", qtyBase: 0, unitCost: 10 },
    { productId: "p2", warehouseId: "w1", qtyBase: 4, unitCost: 10 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.productId, "p2");
});

test("lines that cancel out produce no movement at all", () => {
  // A correction line reversing an earlier one on the same document. Net zero
  // means nothing moved, and a zero-quantity row is one reconciliation has to
  // explain away.
  const out = collapseMovementLines([
    { productId: "p1", warehouseId: "w1", qtyBase: 4 },
    { productId: "p1", warehouseId: "w1", qtyBase: -4 },
  ]);
  assert.deepEqual(out, []);
});

test("output is sorted by product, so lock order is stable across callers", () => {
  const out = collapseMovementLines([
    { productId: "pz", warehouseId: "w1", qtyBase: 1 },
    { productId: "pa", warehouseId: "w1", qtyBase: 1 },
    { productId: "pm", warehouseId: "w1", qtyBase: 1 },
  ]);
  assert.deepEqual(
    out.map((l) => l.productId),
    ["pa", "pm", "pz"],
  );
});

test("issues stay negative — the sign is the caller's, not ours to normalise", () => {
  // `writeMovement` derives the arithmetic from the sign and refuses a movement
  // whose sign disagrees with its type. Flipping one here would turn an issue
  // into a receipt.
  const out = collapseMovementLines([
    { productId: "p1", warehouseId: "w1", qtyBase: -3 },
    { productId: "p1", warehouseId: "w1", qtyBase: -5 },
  ]);
  assert.equal(out[0]?.qtyBase, -8);
});

test("rows with no product or no warehouse are ignored", () => {
  // Service lines on an invoice, which have no stock side at all.
  const out = collapseMovementLines([
    { productId: "", warehouseId: "w1", qtyBase: 3 },
    { productId: "p1", warehouseId: "", qtyBase: 3 },
    { productId: "p1", warehouseId: "w1", qtyBase: 3 },
  ]);
  assert.equal(out.length, 1);
});
