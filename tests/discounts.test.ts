/**
 * Discount arithmetic.
 *
 * Pinned hard because an error here is invisible and total: it reaches every
 * document, every report, and the KDV return. The rule that drives all of it is
 * that KDV is charged on the *matrah* — the amount actually invoiced, after
 * discount — so a discount must reduce the taxable base and let the tax follow
 * it down.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";

const { lineTotals, docTotals } = await import("@/lib/finance/totals");

test("no discount behaves exactly as before", () => {
  const t = lineTotals({ qty: 2, unitPrice: 100, taxRate: 20 });
  assert.equal(t.lineGross, 200);
  assert.equal(t.lineDiscount, 0);
  assert.equal(t.lineSubtotal, 200);
  assert.equal(t.lineTax, 40);
  assert.equal(t.lineTotal, 240);
});

test("a percentage discount reduces the taxable base, and the tax with it", () => {
  // The point of the whole feature: 10% off 200 is 180 of matrah, and KDV is 36
  // — not 40 with 20 taken off the gross afterwards.
  const t = lineTotals({ qty: 2, unitPrice: 100, taxRate: 20, discountRate: 10 });
  assert.equal(t.lineDiscount, 20);
  assert.equal(t.lineSubtotal, 180);
  assert.equal(t.lineTax, 36);
  assert.equal(t.lineTotal, 216);
});

test("an absolute discount applies after the percentage", () => {
  // "10% off, then 50 lira off" — the order is fixed and written down, because
  // the other order gives a different answer and neither is arguable once said.
  const t = lineTotals({ qty: 1, unitPrice: 1000, taxRate: 20, discountRate: 10, discountAmount: 50 });
  assert.equal(t.lineDiscount, 150); // 100 by rate, then 50 flat
  assert.equal(t.lineSubtotal, 850);
  assert.equal(t.lineTax, 170);
});

test("a discount larger than the line cannot make it negative", () => {
  // A negative taxable base would post a debit where a credit belongs and
  // quietly reverse part of an invoice.
  const t = lineTotals({ qty: 1, unitPrice: 100, taxRate: 20, discountAmount: 500 });
  assert.equal(t.lineDiscount, 100);
  assert.equal(t.lineSubtotal, 0);
  assert.equal(t.lineTax, 0);
  assert.equal(t.lineTotal, 0);
});

test("a negative or absurd discount rate is clamped, not obeyed", () => {
  assert.equal(lineTotals({ qty: 1, unitPrice: 100, taxRate: 0, discountRate: -50 }).lineDiscount, 0);
  assert.equal(lineTotals({ qty: 1, unitPrice: 100, taxRate: 0, discountRate: 500 }).lineSubtotal, 0);
});

test("document totals sum the discounted lines", () => {
  const totals = docTotals([
    { qty: 2, unitPrice: 100, taxRate: 20, discountRate: 10 },
    { qty: 1, unitPrice: 50, taxRate: 20 },
  ]);
  assert.equal(totals.grossSubtotal, 250);
  assert.equal(totals.discountTotal, 20);
  assert.equal(totals.subtotal, 230);
  assert.equal(totals.taxTotal, 46);
  assert.equal(totals.total, 276);
});

test("a header discount is apportioned across the lines, not taken off the bottom", () => {
  // THE case this design exists for: two lines at different KDV rates. A lump
  // sum off the total has no rate, so the tax could not be computed from it —
  // spreading it in proportion to each line's base keeps every rate intact.
  const totals = docTotals(
    [
      { qty: 1, unitPrice: 100, taxRate: 20 }, // 20 KDV
      { qty: 1, unitPrice: 100, taxRate: 10 }, // 10 KDV
    ],
    { discountRate: 10 },
  );
  assert.equal(totals.discountTotal, 20);
  assert.equal(totals.subtotal, 180);
  // 90 at 20% + 90 at 10% = 18 + 9. NOT 30 × 0.9 = 27 by coincidence — it is,
  // but only because the split is even; the next test breaks that symmetry.
  assert.equal(totals.taxTotal, 27);
  assert.equal(totals.total, 207);
});

test("an uneven mix of rates still taxes each line at its own rate", () => {
  const totals = docTotals(
    [
      { qty: 1, unitPrice: 900, taxRate: 20 },
      { qty: 1, unitPrice: 100, taxRate: 1 },
    ],
    { discountAmount: 100 },
  );
  assert.equal(totals.subtotal, 900);
  // 810 at 20% = 162, 90 at 1% = 0.90.
  assert.equal(totals.taxTotal, 162.9);
  assert.equal(totals.total, 1062.9);
});

test("the apportioned parts add back to exactly the discount given", () => {
  // Three lines that do not divide evenly — the last must absorb the remainder,
  // or the document's lines stop summing to its own total.
  const lines = [
    { qty: 1, unitPrice: 33.33, taxRate: 20 },
    { qty: 1, unitPrice: 33.33, taxRate: 20 },
    { qty: 1, unitPrice: 33.34, taxRate: 20 },
  ];
  const undiscounted = docTotals(lines);
  const discounted = docTotals(lines, { discountAmount: 10 });
  assert.equal(undiscounted.subtotal, 100);
  assert.equal(discounted.subtotal, 90, "the discount must land exactly, to the cent");
  assert.equal(discounted.discountTotal, 10);
});

test("a header discount larger than the document is clamped", () => {
  const totals = docTotals([{ qty: 1, unitPrice: 100, taxRate: 20 }], { discountAmount: 5000 });
  assert.equal(totals.subtotal, 0);
  assert.equal(totals.taxTotal, 0);
  assert.equal(totals.total, 0);
  assert.equal(totals.discountTotal, 100);
});

test("line and header discounts compose", () => {
  // 10% off the line (200 → 180), then 10% off the document (180 → 162).
  const totals = docTotals([{ qty: 2, unitPrice: 100, taxRate: 20, discountRate: 10 }], { discountRate: 10 });
  assert.equal(totals.grossSubtotal, 200);
  assert.equal(totals.subtotal, 162);
  assert.equal(totals.discountTotal, 38);
  assert.equal(totals.taxTotal, 32.4);
});

test("missing or non-numeric fields are treated as zero, not NaN", () => {
  // These land in currency columns; NaN reaches mysql2 as the bare token `NaN`.
  const t = lineTotals({ qty: 1, unitPrice: 100 } as never);
  assert.equal(t.lineTax, 0);
  assert.equal(t.lineTotal, 100);
  const d = docTotals([{ qty: 1, unitPrice: 100, taxRate: 20 }], { discountRate: undefined });
  assert.equal(d.total, 120);
});

test("an empty document totals to zero rather than NaN", () => {
  const totals = docTotals([]);
  assert.deepEqual(
    { s: totals.subtotal, t: totals.taxTotal, g: totals.total, d: totals.discountTotal },
    { s: 0, t: 0, g: 0, d: 0 },
  );
});

test("no total is ever negative zero", () => {
  // -0 reaches a currency column and reads as a negative amount in reports.
  const totals = docTotals([{ qty: 0, unitPrice: 0, taxRate: 20 }]);
  assert.ok(!Object.is(totals.subtotal, -0));
  assert.ok(!Object.is(totals.taxTotal, -0));
  assert.ok(!Object.is(totals.total, -0));
});
