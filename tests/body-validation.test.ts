/**
 * Request-body validation for the hand-written routes.
 *
 * Entity CRUD has always been validated from metadata. These routes were not:
 * each did `readJson(req) as {...}`, which is a claim about an object the caller
 * controls, not a check on it. The tests below are the inputs that used to get
 * through — every one of them reaches money, stock or SQL.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";

const { AppError } = await import("@/lib/enforcement/errors");
const {
  parseBody,
  posCheckoutSchema,
  paymentSchema,
  closeSessionSchema,
  aggregateSchema,
  stockAdjustmentSchema,
  documentLinesSchema,
} = await import("@/lib/http/body");

/** The parser reads `req.body`, so that is all a fake request needs. */
const req = (body: unknown): Request => ({ body }) as Request;

/** Assert a rejection and hand back the field names it complained about. */
function rejects(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof AppError, "should be an AppError");
    assert.equal(e.httpStatus, 422);
    assert.equal(e.code, "VALIDATION");
    // `field` is optional on ErrorDetail — a whole-body failure has no path.
    // `parseBody` substitutes "body" for that case, so an undefined here would
    // mean the substitution stopped happening, which is worth surfacing rather
    // than smoothing over.
    return (e.details ?? []).map((d) => d.field ?? "<missing field>");
  }
  throw new assert.AssertionError({ message: "expected the body to be rejected" });
}

test("a well-formed checkout passes and comes back parsed", () => {
  const parsed = parseBody(
    req({ lines: [{ qty: 2, unitPrice: 10, taxRate: 20 }], payments: [{ method: "cash", amount: 24 }] }),
    posCheckoutSchema,
  );
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.payments[0]!.amount, 24);
});

test("a checkout with no lines is refused", () => {
  // It used to post nothing and return 201 — a completed sale to the terminal,
  // a missing invoice to the books.
  assert.deepEqual(rejects(() => parseBody(req({ lines: [], payments: [] }), posCheckoutSchema)), ["lines"]);
});

test("a checkout with a non-numeric price is refused", () => {
  // `Number("abc")` is NaN, NaN passes `typeof === "number"`, and mysql2
  // interpolates it as the bare token NaN — which arrives as "Unknown column
  // 'NaN'" from a layer with no idea a price was involved.
  const fields = rejects(() =>
    parseBody(req({ lines: [{ qty: 1, unitPrice: "abc", taxRate: 0 }], payments: [] }), posCheckoutSchema),
  );
  assert.deepEqual(fields, ["lines.0.unitPrice"]);
});

test("NaN and Infinity are refused as amounts", () => {
  // The specific values that survive a `typeof` check and destroy a ledger.
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.deepEqual(rejects(() => parseBody(req({ amount: bad }), paymentSchema)), ["amount"]);
  }
});

test("a negative payment is refused", () => {
  // A negative receipt is a refund, which is a different document with different
  // postings — not a payment with a minus sign.
  assert.deepEqual(rejects(() => parseBody(req({ amount: -50 }), paymentSchema)), ["amount"]);
});

test("closing a till requires the counted cash", () => {
  // `Number(undefined)` was 0, so a close with no count silently reported a
  // perfectly balanced drawer.
  assert.deepEqual(rejects(() => parseBody(req({ sessionId: "1" }), closeSessionSchema)), ["countedCash"]);
  assert.deepEqual(rejects(() => parseBody(req({ countedCash: 100 }), closeSessionSchema)), ["sessionId"]);
  assert.equal(parseBody(req({ sessionId: "1", countedCash: 0 }), closeSessionSchema).countedCash, 0);
});

test("an aggregation with no measures is refused", () => {
  // It produced `SELECT  FROM …`, i.e. a database syntax error returned to the
  // caller as a 500 — their mistake reported as a server fault.
  assert.deepEqual(rejects(() => parseBody(req({ entity: "invoice", measures: [] }), aggregateSchema)), ["measures"]);
  assert.deepEqual(rejects(() => parseBody(req({ entity: "invoice" }), aggregateSchema)), ["measures"]);
});

test("an aggregation limit cannot be used to ask for everything", () => {
  assert.deepEqual(
    rejects(() => parseBody(req({ entity: "invoice", measures: [{ op: "count" }], limit: 1_000_000 }), aggregateSchema)),
    ["limit"],
  );
});

test("a stock adjustment keeps its sign but requires its targets", () => {
  // The sign IS the document: it decides whether stock is written on or off.
  const parsed = parseBody(req({ productId: "1", warehouseId: "2", qtyDelta: -5 }), stockAdjustmentSchema);
  assert.equal(parsed.qtyDelta, -5);
  assert.deepEqual(rejects(() => parseBody(req({ qtyDelta: 5 }), stockAdjustmentSchema)), ["productId", "warehouseId"]);
});

test("a document line must carry a description", () => {
  // It is what a person reads on the printed document; a product id and numbers
  // is not a line anyone can check.
  assert.deepEqual(
    rejects(() => parseBody(req([{ qty: 1, unitPrice: 5 }]), documentLinesSchema)),
    ["0.description"],
  );
});

test("a tax rate outside 0–100 is refused", () => {
  const fields = rejects(() =>
    parseBody(req({ lines: [{ qty: 1, unitPrice: 5, taxRate: 2000 }], payments: [] }), posCheckoutSchema),
  );
  assert.deepEqual(fields, ["lines.0.taxRate"]);
});

test("every problem is reported at once, not one per round trip", () => {
  // A form that fixes one field only to be told about the next teaches people to
  // stop reading the message.
  const fields = rejects(() =>
    parseBody(req({ lines: [{ qty: "x", unitPrice: "y", taxRate: "z" }], payments: [] }), posCheckoutSchema),
  );
  assert.deepEqual(fields, ["lines.0.qty", "lines.0.unitPrice", "lines.0.taxRate"]);
});

test("unknown fields are dropped rather than passed through", () => {
  // The handler works with the schema's output, so a caller cannot smuggle an
  // extra key into a downstream write by adding it to the request.
  const parsed = parseBody(
    req({ amount: 10, isAdmin: true, tenantId: "someone-else" }),
    paymentSchema,
  ) as Record<string, unknown>;
  assert.equal(parsed.isAdmin, undefined);
  assert.equal(parsed.tenantId, undefined);
  assert.equal(parsed.amount, 10);
});

test("a missing or non-object body is refused, not crashed on", () => {
  for (const bad of [undefined, null, "a string", 42, []]) {
    assert.throws(() => parseBody(req(bad), paymentSchema), /Validation failed/);
  }
});
