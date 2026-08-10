/**
 * KDV tevkifatı.
 *
 * The buyer withholds part of the VAT and remits it directly, so the seller
 * collects — and declares — less than the VAT the invoice shows. Getting the
 * split wrong overstates what is owed to the tax office by exactly the withheld
 * amount, which is the kind of error nobody notices until a reconciliation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TEVKIFAT_RATIOS, applyTevkifat, formatTevkifat } from "@/lib/finance/tevkifat";

test("no withholding leaves the ordinary case untouched", () => {
  const r = applyTevkifat(10_000, 2_000, 0);
  assert.deepEqual(r, { vatTotal: 2_000, withheld: 0, collectible: 2_000, documentTotal: 12_000 });
});

test("5/10 splits the VAT in half and reduces the collectible total", () => {
  const r = applyTevkifat(10_000, 2_000, 5);
  assert.equal(r.withheld, 1_000, "the buyer remits this directly");
  assert.equal(r.collectible, 1_000, "the seller collects and declares this");
  assert.equal(r.documentTotal, 11_000, "base + collectible VAT");
});

test("the two parts always sum to the full VAT", () => {
  // Deliberately awkward numbers: the collectible part is derived by subtraction
  // so no rounding residual can appear between them.
  for (const ratio of TEVKIFAT_RATIOS) {
    for (const [base, vat] of [[1_333.33, 266.67], [999.99, 200], [7, 1.4]]) {
      const r = applyTevkifat(base!, vat!, ratio);
      assert.equal(
        Math.round((r.withheld + r.collectible) * 100) / 100,
        Math.round(vat! * 100) / 100,
        `ratio ${ratio}/10 on VAT ${vat}`,
      );
    }
  }
});

test("9/10 leaves the seller a tenth", () => {
  const r = applyTevkifat(1_000, 200, 9);
  assert.equal(r.withheld, 180);
  assert.equal(r.collectible, 20);
  assert.equal(r.documentTotal, 1_020);
});

test("full withholding collects no VAT at all", () => {
  const r = applyTevkifat(1_000, 200, 10);
  assert.equal(r.collectible, 0);
  assert.equal(r.documentTotal, 1_000, "the invoice total is the bare base");
});

test("a zero-VAT supply is unaffected by any ratio", () => {
  const r = applyTevkifat(5_000, 0, 5);
  assert.equal(r.withheld, 0);
  assert.equal(r.collectible, 0);
  assert.equal(r.documentTotal, 5_000);
});

test("the ratio prints the way the legislation writes it", () => {
  assert.equal(formatTevkifat(5), "5/10");
  assert.equal(formatTevkifat(0), "", "no withholding prints nothing");
});
