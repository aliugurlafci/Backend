/**
 * Stock alert classification.
 *
 * `classify` is the whole decision, so it is tested directly rather than through
 * a database: which condition a balance is in, and — the part that is easy to
 * get wrong — which balances are in NO condition at all. A detector that is
 * merely over-eager is not a smaller version of a correct one; it is an alert
 * channel that gets muted, and a muted channel misses the real shortage too.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import { classifyBalance, STAGNANT_DAYS } from "@/lib/inventory/alerts";
import type { EntityRecord } from "@/lib/metadata/types";

const NOW = "2026-08-08T10:00:00.000Z";

function balance(over: Partial<EntityRecord> = {}): EntityRecord {
  return {
    id: "1",
    tenantId: "T",
    orgId: "O",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    stockKey: "p1|w1",
    productId: "p1",
    warehouseId: "w1",
    qty: 10,
    value: 100,
    lastMovedAt: NOW,
    ...over,
  } as EntityRecord;
}

const product = (reorderLevel: number): EntityRecord => ({ id: "p1", reorderLevel }) as unknown as EntityRecord;

test("stock at or below the reorder level opens a reorder alert", () => {
  assert.equal(classifyBalance(balance({ qty: 5 }), product(5), NOW)?.kind, "reorder");
  assert.equal(classifyBalance(balance({ qty: 4 }), product(5), NOW)?.kind, "reorder");
});

test("stock above the reorder level is not an alert", () => {
  assert.equal(classifyBalance(balance({ qty: 6 }), product(5), NOW), null);
});

test("a reorder level of 0 means unwatched, not 'alert at zero'", () => {
  // Otherwise every product anyone ever let run out — including the ones
  // deliberately not stocked — would raise an alert on the first scan.
  assert.equal(classifyBalance(balance({ qty: 0, value: 0 }), product(0), NOW), null);
});

test("a negative balance is reported as negative, not as 'reorder'", () => {
  // It is below the reorder level too, but "go and buy some" is the wrong
  // instruction when the books say you hold minus four: something was recorded
  // wrongly, and buying more will not make the number right.
  const c = classifyBalance(balance({ qty: -4 }), product(5), NOW);
  assert.equal(c?.kind, "negative");
  assert.equal(c?.qty, -4);
});

test("held stock that has not moved for a quarter is stagnant", () => {
  const old = new Date(Date.parse(NOW) - (STAGNANT_DAYS + 1) * 86_400_000).toISOString();
  assert.equal(classifyBalance(balance({ lastMovedAt: old }), product(0), NOW)?.kind, "stagnant");
});

test("stock that moved recently is not stagnant", () => {
  const recent = new Date(Date.parse(NOW) - 3 * 86_400_000).toISOString();
  assert.equal(classifyBalance(balance({ lastMovedAt: recent }), product(0), NOW), null);
});

test("a zero balance is absent, not stagnant", () => {
  // Nothing is tied up in stock that is not there. Counting it would let long
  // discontinued lines dominate the list and drown the items that cost money.
  const old = new Date(Date.parse(NOW) - 400 * 86_400_000).toISOString();
  assert.equal(classifyBalance(balance({ qty: 0, value: 0, lastMovedAt: old }), product(0), NOW), null);
});

test("a balance below its reorder level is reported as low, not as stagnant", () => {
  // Both are true for an item that is nearly out and has not sold recently.
  // "Reorder" is the actionable one.
  const old = new Date(Date.parse(NOW) - 400 * 86_400_000).toISOString();
  assert.equal(classifyBalance(balance({ qty: 2, lastMovedAt: old }), product(5), NOW)?.kind, "reorder");
});

test("a missing product does not crash the scan", () => {
  // A balance whose product was deleted still has a row. Throwing here would
  // stop the whole nightly scan over one orphan.
  assert.equal(classifyBalance(balance({ qty: 3 }), undefined, NOW), null);
});

test("an unparseable lastMovedAt is not treated as infinitely old", () => {
  // Date.parse returns NaN; a naive difference would come out as 0 or NaN and
  // either silently drop the item or flag everything.
  assert.equal(classifyBalance(balance({ lastMovedAt: "not-a-date" }), product(0), NOW), null);
});
