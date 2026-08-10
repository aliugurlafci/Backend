/**
 * Business condition detection outside stock.
 *
 * Every one of these conditions was computable before the scan existed and
 * nothing computed it: a purchase order sat past its promised date, a transfer
 * sat in transit, a till closed short, and the only way to notice was for
 * somebody to open the document. The data was there; the question was never
 * asked.
 *
 * The classifiers are pure, which is where the judgement lives — what counts as
 * late, what counts as material, and above all what does NOT qualify. An alert
 * system's failure mode is not missing things; it is crying wolf until somebody
 * mutes the channel, and then missing things.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import type { EntityRecord } from "@/lib/metadata/types";

const {
  classifyPurchaseOrder,
  classifyTransfer,
  classifyCount,
  classifySession,
  classifyBill,
  scanOperationsAlerts,
  TRANSIT_DAYS,
  COUNT_VARIANCE,
  TILL_VARIANCE,
  PRICE_VARIANCE,
} = await import("@/lib/ops/alerts");

const NOW = "2026-08-08T10:00:00.000Z";
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
const rec = (o: Record<string, unknown>) => o as unknown as EntityRecord;

// ---- purchase orders -------------------------------------------------------

test("a purchase order past its expected date is late", () => {
  const c = classifyPurchaseOrder(rec({ id: "1", number: "PO-1", status: "approved", expectedDate: "2026-08-01" }), NOW);
  assert.equal(c?.kind, "po_overdue");
  assert.equal(c?.amount, 7, "seven days late");
});

test("a partially received order is still late for the rest", () => {
  // `partial` means some of it arrived. The remainder is exactly what somebody
  // needs to chase, and treating the order as settled is how the tail of a
  // delivery quietly never turns up.
  assert.ok(classifyPurchaseOrder(rec({ id: "1", status: "partial", expectedDate: "2026-08-01" }), NOW));
});

test("an order that is not yet due, or already settled, is not late", () => {
  assert.equal(classifyPurchaseOrder(rec({ id: "1", status: "approved", expectedDate: "2026-08-20" }), NOW), null);
  for (const status of ["draft", "pending", "received", "rejected", "cancelled"]) {
    assert.equal(
      classifyPurchaseOrder(rec({ id: "1", status, expectedDate: "2026-08-01" }), NOW),
      null,
      `${status} has nothing left to chase`,
    );
  }
});

test("an order with no promised date is never late", () => {
  // There is nothing to be late against. Treating a missing date as "overdue"
  // would light up every order placed without one, which is most of them early
  // on, and the channel would be muted before it was ever useful.
  assert.equal(classifyPurchaseOrder(rec({ id: "1", status: "approved", expectedDate: null }), NOW), null);
});

test("an order due today is not yet late", () => {
  assert.equal(classifyPurchaseOrder(rec({ id: "1", status: "approved", expectedDate: NOW.slice(0, 10) }), NOW), null);
});

// ---- transfers -------------------------------------------------------------

test("a transfer sitting in transit past the window is stuck", () => {
  const c = classifyTransfer(rec({ id: "1", number: "TR-1", status: "in_transit", dispatchedAt: daysAgo(TRANSIT_DAYS) }), NOW);
  assert.equal(c?.kind, "transfer_stuck");
});

test("a transfer still within the window, or already received, is not stuck", () => {
  assert.equal(classifyTransfer(rec({ id: "1", status: "in_transit", dispatchedAt: daysAgo(TRANSIT_DAYS - 1) }), NOW), null);
  assert.equal(classifyTransfer(rec({ id: "1", status: "posted", dispatchedAt: daysAgo(30) }), NOW), null);
});

// ---- counts ----------------------------------------------------------------

test("a posted count is flagged once its write-off is material", () => {
  assert.equal(classifyCount(rec({ id: "1", status: "posted", varianceValue: COUNT_VARIANCE, varianceCount: 3 }))?.kind, "count_variance");
  assert.equal(classifyCount(rec({ id: "1", status: "posted", varianceValue: COUNT_VARIANCE - 1 })), null);
});

test("a shortfall counts as much as an overage", () => {
  // The absolute value, not the signed one. Stock found is as much a sign of a
  // counting problem as stock missing, and a rule that only watches losses
  // misses half of them.
  assert.ok(classifyCount(rec({ id: "1", status: "posted", varianceValue: -(COUNT_VARIANCE + 10) })));
});

test("a count that is not posted yet is not a variance", () => {
  // A count in progress has a variance that is still changing. Alerting on it
  // would announce a number nobody has agreed to.
  for (const status of ["draft", "counting", "review", "cancelled"]) {
    assert.equal(classifyCount(rec({ id: "1", status, varianceValue: 9_999 })), null, status);
  }
});

// ---- till sessions ---------------------------------------------------------

test("a till that closed out of balance is flagged, in either direction", () => {
  const short = classifySession(rec({ id: "1", number: "S-1", status: "closed", variance: -(TILL_VARIANCE + 5) }));
  const over = classifySession(rec({ id: "2", number: "S-2", status: "closed", variance: TILL_VARIANCE + 5 }));
  // Titles are written in the ORG language (AULA_DEFAULT_LOCALE, "tr" by
  // default) — assert the direction is distinguishable, not the English word.
  assert.ok(short?.title && over?.title, "both directions must produce an alert");
  assert.notEqual(short.title, over.title, "short and over must read differently");
  assert.match(String(short.title), /eksik|short|Fehlbetrag/);
  assert.match(String(over.title), /fazla|over|Überschuss/);
});

test("small drift and open tills are left alone", () => {
  assert.equal(classifySession(rec({ id: "1", status: "closed", variance: TILL_VARIANCE - 0.01 })), null);
  // An open till has not been counted yet; its variance is meaningless.
  assert.equal(classifySession(rec({ id: "1", status: "open", variance: 9_999 })), null);
});

// ---- vendor bills ----------------------------------------------------------

test("a bill that differs materially from the receipt is flagged", () => {
  assert.equal(classifyBill(rec({ id: "1", number: "VB-1", priceVariance: PRICE_VARIANCE }))?.kind, "price_variance");
  assert.equal(classifyBill(rec({ id: "1", priceVariance: PRICE_VARIANCE - 1 })), null);
});

test("an unmatched bill is not the same as a bill that matched exactly", () => {
  // Null means nobody has compared it to a receipt; zero means somebody did and
  // they agreed. Treating null as zero would silently report every unmatched
  // bill as reconciled.
  assert.equal(classifyBill(rec({ id: "1", priceVariance: null })), null);
  assert.equal(classifyBill(rec({ id: "1" })), null);
  assert.equal(classifyBill(rec({ id: "1", priceVariance: 0 })), null);
});

// ---- the scan itself -------------------------------------------------------

test("the scan opens an alert, does not repeat it, and closes it when it clears", async () => {
  const { getQueryEngine } = await import("@/lib/data/store");
  const { systemContext } = await import("@/lib/context/resolver");
  const { TENANT_ID, ORG_ID } = await import("@/lib/config/env");
  const qe = await getQueryEngine();
  const ctx = () => ({ ...systemContext(TENANT_ID, ORG_ID), at: NOW });

  const supplier = await qe.create(ctx(), "supplier", { name: "OpsAlert Ltd" });
  const warehouse = await qe.create(ctx(), "warehouse", { name: "OA", code: "OA" });
  const po = await qe.create(ctx(), "purchaseOrder", {
    supplierId: String(supplier.id),
    warehouseId: String(warehouse.id),
    status: "approved",
    expectedDate: "2026-08-01",
    currencyCode: "TRY",
  });

  const first = await scanOperationsAlerts(ctx());
  assert.equal(first.opened, 1, "the late order is reported");

  // Saying it again every night is how an alert channel gets muted, taking the
  // urgent messages with it.
  const second = await scanOperationsAlerts(ctx());
  assert.equal(second.opened, 0, "not re-announced");
  assert.equal(second.ongoing, 1, "still open, deliberately untouched");

  // The goods arrive.
  await qe.patchComputed(ctx(), "purchaseOrder", String(po.id), { status: "received" });
  const third = await scanOperationsAlerts(ctx());
  assert.equal(third.resolved, 1, "the alert closes itself");

  const open = await qe.listComplete(ctx(), "operationsAlert", { filters: [{ field: "status", op: "eq", value: "open" }] });
  assert.equal(open.length, 0, "the open list is what is wrong right now, not a log");
});

test("a condition that becomes true again is a NEW alert", async () => {
  // A second shortage is a second event, not a continuation of the first — the
  // same rule `stockAlert` follows.
  const { getQueryEngine } = await import("@/lib/data/store");
  const { systemContext } = await import("@/lib/context/resolver");
  const { TENANT_ID, ORG_ID } = await import("@/lib/config/env");
  const qe = await getQueryEngine();
  const ctx = () => ({ ...systemContext(TENANT_ID, ORG_ID), at: NOW });

  const supplier = await qe.create(ctx(), "supplier", { name: "Repeat Ltd" });
  const warehouse = await qe.create(ctx(), "warehouse", { name: "RP", code: "RP" });
  const po = await qe.create(ctx(), "purchaseOrder", {
    supplierId: String(supplier.id),
    warehouseId: String(warehouse.id),
    status: "approved",
    expectedDate: "2026-08-02",
    currencyCode: "TRY",
  });
  await scanOperationsAlerts(ctx());
  await qe.patchComputed(ctx(), "purchaseOrder", String(po.id), { status: "received" });
  await scanOperationsAlerts(ctx());
  await qe.patchComputed(ctx(), "purchaseOrder", String(po.id), { status: "approved" });
  const again = await scanOperationsAlerts(ctx());
  assert.equal(again.opened, 1, "reopening the condition opens a fresh alert");
});
