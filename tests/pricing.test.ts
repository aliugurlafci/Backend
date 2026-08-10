/**
 * Price resolution.
 *
 * Every branch here decides what a customer is charged, so the order is pinned
 * rather than left to whatever the rows came back in. "Why did it charge that?"
 * needs one answer, and these tests are it.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";

const { resolvePrice, listApplies } = await import("@/lib/pricing/resolve");
type Meta = Parameters<typeof listApplies>[0];
type Rule = Parameters<typeof resolvePrice>[2][number];

const TODAY = "2026-08-08";

const list = (over: Partial<Meta> = {}): Meta => ({
  id: "L1",
  currencyCode: "TRY",
  active: true,
  ...over,
});

const rule = (over: Partial<Rule> = {}): Rule => ({
  priceListId: "L1",
  productId: "P1",
  minQty: 1,
  unitPrice: 90,
  ...over,
});

const query = (over: Partial<Parameters<typeof resolvePrice>[0]> = {}) => ({
  productId: "P1",
  qty: 1,
  currencyCode: "TRY",
  onDate: TODAY,
  ...over,
});

test("with no lists at all, the product's own price is used", () => {
  // Pricing must never fail: a line that could not be priced would block a sale
  // over a missing configuration row.
  const r = resolvePrice(query(), [], [], 100);
  assert.deepEqual(r, { unitPrice: 100, discountRate: 0, source: "product", priceListId: null });
});

test("the default list beats the product price", () => {
  const r = resolvePrice(query(), [list({ isDefault: true })], [rule()], 100);
  assert.equal(r.unitPrice, 90);
  assert.equal(r.source, "default-list");
});

test("the customer's own list beats the default list", () => {
  // A negotiated price is the agreement, not a starting point for a general list
  // to improve on — even when the general list is cheaper.
  const lists = [list({ id: "DEF", isDefault: true }), list({ id: "CUST" })];
  const rules = [
    rule({ priceListId: "DEF", unitPrice: 80 }),
    rule({ priceListId: "CUST", unitPrice: 95 }),
  ];
  const r = resolvePrice(query({ customerPriceListId: "CUST" }), lists, rules, 100);
  assert.equal(r.unitPrice, 95);
  assert.equal(r.source, "customer-list");
});

test("a customer list that does not price this product falls through", () => {
  const lists = [list({ id: "DEF", isDefault: true }), list({ id: "CUST" })];
  const rules = [rule({ priceListId: "DEF", unitPrice: 80 })];
  const r = resolvePrice(query({ customerPriceListId: "CUST" }), lists, rules, 100);
  assert.equal(r.unitPrice, 80);
  assert.equal(r.source, "default-list");
});

test("a quantity break applies from its threshold up, not only at it", () => {
  // A list with breaks at 1, 10 and 100 prices an order of 50 at the "10" row.
  // Exact matching would leave most quantities unpriced.
  const rules = [
    rule({ minQty: 1, unitPrice: 100 }),
    rule({ minQty: 10, unitPrice: 90 }),
    rule({ minQty: 100, unitPrice: 80 }),
  ];
  const lists = [list({ isDefault: true })];
  assert.equal(resolvePrice(query({ qty: 1 }), lists, rules, 999).unitPrice, 100);
  assert.equal(resolvePrice(query({ qty: 9 }), lists, rules, 999).unitPrice, 100);
  assert.equal(resolvePrice(query({ qty: 10 }), lists, rules, 999).unitPrice, 90);
  assert.equal(resolvePrice(query({ qty: 50 }), lists, rules, 999).unitPrice, 90);
  assert.equal(resolvePrice(query({ qty: 100 }), lists, rules, 999).unitPrice, 80);
  assert.equal(resolvePrice(query({ qty: 1000 }), lists, rules, 999).unitPrice, 80);
});

test("a quantity below every break falls back to the product price", () => {
  const rules = [rule({ minQty: 10, unitPrice: 90 })];
  const r = resolvePrice(query({ qty: 5 }), [list({ isDefault: true })], rules, 100);
  assert.equal(r.unitPrice, 100);
  assert.equal(r.source, "product");
});

test("duplicate breaks resolve to the cheaper price", () => {
  // A configuration mistake either way; charging the lower of the two is the
  // failure that does not end in an argument with a customer.
  const rules = [rule({ minQty: 10, unitPrice: 95 }), rule({ minQty: 10, unitPrice: 85 })];
  assert.equal(resolvePrice(query({ qty: 20 }), [list({ isDefault: true })], rules, 100).unitPrice, 85);
});

test("a rule can carry a discount as well as a price", () => {
  const r = resolvePrice(
    query(),
    [list({ isDefault: true })],
    [rule({ unitPrice: 100, discountRate: 15 })],
    100,
  );
  assert.equal(r.discountRate, 15);
});

// ---- what must NOT apply ----------------------------------------------------

test("an inactive list is ignored", () => {
  const r = resolvePrice(query(), [list({ isDefault: true, active: false })], [rule()], 100);
  assert.equal(r.source, "product");
});

test("a list in another currency does not apply, and is not converted", () => {
  // Converting here would invent an exchange rate at the moment a line is
  // priced, bury it inside a unit price and leave nothing to reconcile — and
  // this ledger does not convert between currencies at all.
  const r = resolvePrice(query({ currencyCode: "TRY" }), [list({ isDefault: true, currencyCode: "EUR" })], [rule()], 100);
  assert.equal(r.source, "product");
  assert.equal(r.unitPrice, 100);
});

test("validity is judged against the document date, not today", () => {
  const expired = [list({ isDefault: true, validTo: "2026-01-31" })];
  const future = [list({ isDefault: true, validFrom: "2027-01-01" })];
  assert.equal(resolvePrice(query({ onDate: TODAY }), expired, [rule()], 100).source, "product");
  assert.equal(resolvePrice(query({ onDate: TODAY }), future, [rule()], 100).source, "product");
  // A document dated inside the window still gets the list price — backdating an
  // invoice must price it as of that date.
  assert.equal(resolvePrice(query({ onDate: "2026-01-15" }), expired, [rule()], 100).unitPrice, 90);
});

test("validity bounds are inclusive on both ends", () => {
  const bounded = [list({ isDefault: true, validFrom: "2026-08-08", validTo: "2026-08-08" })];
  assert.equal(resolvePrice(query({ onDate: "2026-08-08" }), bounded, [rule()], 100).unitPrice, 90);
  assert.equal(resolvePrice(query({ onDate: "2026-08-07" }), bounded, [rule()], 100).source, "product");
  assert.equal(resolvePrice(query({ onDate: "2026-08-09" }), bounded, [rule()], 100).source, "product");
});

test("a full timestamp is accepted where a date is expected", () => {
  const bounded = [list({ isDefault: true, validTo: "2026-08-08" })];
  assert.equal(resolvePrice(query({ onDate: "2026-08-08T23:59:00.000Z" }), bounded, [rule()], 100).unitPrice, 90);
});

test("a rule for another product is ignored", () => {
  const r = resolvePrice(query({ productId: "P1" }), [list({ isDefault: true })], [rule({ productId: "P2" })], 100);
  assert.equal(r.source, "product");
});

test("a non-default list nobody is assigned to does not price anything", () => {
  // Otherwise creating a list would silently change prices for every customer.
  const r = resolvePrice(query(), [list({ id: "PROMO" })], [rule({ priceListId: "PROMO", unitPrice: 10 })], 100);
  assert.equal(r.source, "product");
  assert.equal(r.unitPrice, 100);
});

test("listApplies is the single gate the rest depends on", () => {
  assert.equal(listApplies(list(), "TRY", TODAY), true);
  assert.equal(listApplies(list({ active: false }), "TRY", TODAY), false);
  assert.equal(listApplies(list({ currencyCode: "USD" }), "TRY", TODAY), false);
});
