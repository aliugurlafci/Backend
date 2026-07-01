/**
 * Unit checks for barcode scan-equivalence expansion. These guard the fix for
 * "scanned product not found": the same GTIN is encoded at different lengths by
 * UPC-A / EAN-13 / UPC-E and a camera may report either form, so lookup must try
 * every equivalent representation. The mobile app ships a verbatim copy of
 * `barcodeCandidates`, so these vectors apply to both online and offline lookup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { barcodeCandidates } from "@/lib/barcode/check-digit";

test("UPC-A (12) also matches its EAN-13 (leading-zero) form", () => {
  const c = barcodeCandidates("036000291452");
  assert.deepEqual(c, ["036000291452", "0036000291452"]);
});

test("EAN-13 with a leading zero also matches the bare UPC-A", () => {
  const c = barcodeCandidates("0036000291452");
  assert.deepEqual(c, ["0036000291452", "036000291452"]);
});

test("EAN-13 without a leading zero has no UPC-A equivalent", () => {
  const c = barcodeCandidates("4006381333931");
  assert.deepEqual(c, ["4006381333931"]);
});

test("UPC-E (8) expands to its UPC-A and EAN-13 forms", () => {
  const c = barcodeCandidates("04252614");
  assert.ok(c.includes("042100005264"), `expected UPC-A form, got ${c.join(",")}`);
  assert.ok(c.includes("0042100005264"), `expected EAN-13 form, got ${c.join(",")}`);
  assert.equal(c[0], "04252614"); // raw scan stays first (most specific)
});

test("GTIN-14 / ITF-14 with a leading zero falls back to the EAN-13", () => {
  const c = barcodeCandidates("00036000291452");
  assert.ok(c.includes("0036000291452"));
});

test("non-numeric Code128 values are returned untouched", () => {
  assert.deepEqual(barcodeCandidates("ABC-123-XYZ"), ["ABC-123-XYZ"]);
});

test("blank / whitespace yields no candidates", () => {
  assert.deepEqual(barcodeCandidates("   "), []);
  assert.deepEqual(barcodeCandidates(""), []);
});

test("surrounding whitespace is trimmed before expansion", () => {
  assert.deepEqual(barcodeCandidates("  036000291452 "), ["036000291452", "0036000291452"]);
});
