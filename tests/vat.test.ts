/**
 * KDV summarisation.
 *
 * The reason input and output VAT are tracked in separate accounts (191 and 391)
 * is that the declaration reports them separately — the net alone cannot be
 * filed. These pin that split, and the carry-forward rule: excess input VAT is
 * not a refund, it moves to the next period as devreden KDV.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VAT_RATE, VAT_RATES, isStatutoryVatRate, summariseVat } from "@/lib/finance/vat";

test("the statutory rates are exactly 20 / 10 / 1 / 0", () => {
  assert.deepEqual(
    VAT_RATES.map((r) => r.rate),
    [20, 10, 1, 0],
  );
  assert.equal(DEFAULT_VAT_RATE, 20);
});

test("a non-statutory rate is recognised as such", () => {
  assert.equal(isStatutoryVatRate(20), true);
  assert.equal(isStatutoryVatRate(1), true);
  // The classic typo: 2 where 20 was meant.
  assert.equal(isStatutoryVatRate(2), false);
  assert.equal(isStatutoryVatRate(18), false); // the old general rate
});

test("output above input is payable", () => {
  const s = summariseVat(2000, 800);
  assert.equal(s.output, 2000);
  assert.equal(s.input, 800);
  assert.equal(s.payable, 1200);
  assert.equal(s.carriedForward, 0);
});

test("input above output carries forward instead of becoming a refund", () => {
  const s = summariseVat(500, 900);
  assert.equal(s.payable, 0, "nothing is remitted");
  assert.equal(s.carriedForward, 400, "the excess moves to the next period");
});

test("equal sides leave nothing owed and nothing carried", () => {
  const s = summariseVat(1000, 1000);
  assert.equal(s.payable, 0);
  assert.equal(s.carriedForward, 0);
});

test("both sides are reported even when one is zero", () => {
  // A period with purchases but no sales still has to declare the input side.
  const s = summariseVat(0, 750);
  assert.equal(s.output, 0);
  assert.equal(s.input, 750);
  assert.equal(s.carriedForward, 750);
});

test("amounts are rounded to cents and never negative zero", () => {
  const s = summariseVat(100.005, 100.005);
  assert.equal(s.payable, 0);
  assert.equal(s.carriedForward, 0);
  assert.ok(!Object.is(s.carriedForward, -0), "must not report -0");
});
