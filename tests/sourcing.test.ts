/**
 * Purchase requests and comparing supplier offers.
 *
 * Purchasing began at the purchase order — the point where the company has
 * already committed. Who wanted this, why, when they needed it, and what the
 * alternatives cost happened in conversation and was gone by the time somebody
 * queried the invoice three months later.
 *
 * The comparison is deliberately not a ranking. Cheapest is not a decision: an
 * offer that arrives after the goods were needed is worth nothing, and a
 * supplier who can only supply half the lines is not comparable to one who can
 * supply all of them. The numbers go side by side; a person decides, and the
 * reason is recorded.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import type { RequestContext } from "@/lib/context/types";

const { getQueryEngine } = await import("@/lib/data/store");
const { systemContext } = await import("@/lib/context/resolver");
const { TENANT_ID, ORG_ID } = await import("@/lib/config/env");
const { getFinanceService } = await import("@/lib/finance/service");
const { compareQuotes, awardQuote, orderRequestDirect } = await import("@/lib/purchasing/sourcing");
const { priceFor } = await import("@/lib/purchasing/supplier-price");

const ctx = (): RequestContext => systemContext(TENANT_ID, ORG_ID);

let seq = 0;

/** A request for two items, with three suppliers standing by. */
async function scene() {
  const qe = await getQueryEngine();
  const finance = await getFinanceService();
  const c = ctx();
  const n = ++seq;

  const warehouse = await qe.create(c, "warehouse", { name: `SQW${n}`, code: `SQW${n}` });
  const cheapCo = await qe.create(c, "supplier", { name: `Ucuzcu ${n}` });
  const fastCo = await qe.create(c, "supplier", { name: `Hızlı ${n}` });
  const dearCo = await qe.create(c, "supplier", { name: `Pahalı ${n}` });
  const widget = await qe.create(c, "product", { name: `Vida ${n}`, sku: `SQ-A${n}`, unitPrice: 5, trackStock: true });

  const request = await finance.createDocument(c, "purchaseRequest", "STK", {
    title: `Atölye ihtiyacı ${n}`,
    warehouseId: String(warehouse.id),
    requestedDate: c.at.slice(0, 10),
    neededBy: "2026-09-01",
    priority: "normal",
    status: "draft",
  });
  const lineA = await qe.create(c, "purchaseRequestLine", {
    requestId: request.id,
    productId: String(widget.id),
    description: "Vida 5mm",
    qty: 100,
    estimatedPrice: 5,
  });
  // No product id: the half of requests that are not in the catalogue yet.
  const lineB = await qe.create(c, "purchaseRequestLine", {
    requestId: request.id,
    productId: null,
    description: "Özel imalat kelepçe",
    qty: 20,
    estimatedPrice: 40,
  });

  return {
    c,
    qe,
    finance,
    warehouse: String(warehouse.id),
    cheapCo: String(cheapCo.id),
    fastCo: String(fastCo.id),
    dearCo: String(dearCo.id),
    widget: String(widget.id),
    request: String(request.id),
    lineA: String(lineA.id),
    lineB: String(lineB.id),
  };
}

/** A supplier's offer. `lines` are [requestLineId, unitPrice, unavailable?]. */
async function quote(
  s: Awaited<ReturnType<typeof scene>>,
  supplierId: string,
  lines: [string, number, boolean?][],
  header: Record<string, unknown> = {},
) {
  const qe = await getQueryEngine();
  const doc = await s.finance.createDocument(s.c, "supplierQuote", "TKL", {
    requestId: s.request,
    supplierId,
    currencyCode: "TRY",
    quotedAt: s.c.at.slice(0, 10),
    status: "received",
    ...header,
  });
  let subtotal = 0;
  for (const [requestLineId, unitPrice, unavailable] of lines) {
    const requestLine = await qe.get(s.c, "purchaseRequestLine", requestLineId);
    const qty = Number(requestLine.qty ?? 0);
    const lineTotal = unavailable ? 0 : Math.round(qty * unitPrice * 100) / 100;
    subtotal += lineTotal;
    await qe.createWithComputed(
      s.c,
      "supplierQuoteLine",
      {
        quoteId: doc.id,
        requestLineId,
        productId: requestLine.productId ?? null,
        description: String(requestLine.description),
        qty,
        unitPrice,
        taxRate: 0,
        unavailable: Boolean(unavailable),
      },
      { lineTotal },
    );
  }
  await qe.patchComputed(s.c, "supplierQuote", String(doc.id), {
    subtotal,
    taxTotal: 0,
    total: subtotal,
  });
  return String(doc.id);
}

test("the comparison puts every offer for a line side by side", async () => {
  const s = await scene();
  await quote(s, s.cheapCo, [[s.lineA, 4], [s.lineB, 38]]);
  await quote(s, s.dearCo, [[s.lineA, 6], [s.lineB, 42]]);

  const cmp = await compareQuotes(s.c, s.request);
  assert.equal(cmp.rows.length, 2);
  assert.equal(cmp.rows[0]?.offers.length, 2);
  assert.equal(cmp.rows[0]?.description, "Vida 5mm");
  assert.equal(cmp.rows[0]?.estimatedPrice, 5, "the requester's guess, for context");
});

test("the cheapest supplier is marked per LINE, not per quote", async () => {
  // Splitting an order between suppliers is a real option, and a comparison
  // that only totals the quotes cannot show it.
  const s = await scene();
  await quote(s, s.cheapCo, [[s.lineA, 4], [s.lineB, 45]]);
  await quote(s, s.dearCo, [[s.lineA, 6], [s.lineB, 38]]);

  const cmp = await compareQuotes(s.c, s.request);
  const winnerOf = (i: number) => cmp.rows[i]?.offers.find((o) => o.cheapest)?.supplierId;
  assert.equal(winnerOf(0), s.cheapCo);
  assert.equal(winnerOf(1), s.dearCo, "cheapest on the second line is the dearer supplier overall");
});

test("a line the supplier cannot supply is not a price of zero", async () => {
  // Counting an unavailable line at zero would make the supplier who can supply
  // least look cheapest.
  const s = await scene();
  await quote(s, s.cheapCo, [[s.lineA, 4], [s.lineB, 0, true]]);
  await quote(s, s.dearCo, [[s.lineA, 6], [s.lineB, 42]]);

  const cmp = await compareQuotes(s.c, s.request);
  const second = cmp.rows[1];
  assert.equal(second?.offers.find((o) => o.supplierId === s.cheapCo)?.unavailable, true);
  assert.equal(second?.offers.find((o) => o.cheapest)?.supplierId, s.dearCo);

  const summary = cmp.quotes.find((q) => q.supplierId === s.cheapCo);
  assert.equal(summary?.linesQuoted, 1, "and partial cover is visible");
  assert.equal(summary?.linesRequested, 2);
});

test("a tie marks both, rather than silently preferring one", async () => {
  const s = await scene();
  await quote(s, s.cheapCo, [[s.lineA, 5]]);
  await quote(s, s.fastCo, [[s.lineA, 5]]);
  const cmp = await compareQuotes(s.c, s.request);
  assert.equal(cmp.rows[0]?.offers.filter((o) => o.cheapest).length, 2);
});

test("an expired quote is reported as expired, not hidden", async () => {
  // A buyer needs to see that the cheapest offer has lapsed, not to find the
  // options mysteriously reduced.
  const s = await scene();
  await quote(s, s.cheapCo, [[s.lineA, 4]], { validUntil: "2020-01-01" });
  const cmp = await compareQuotes(s.c, s.request);
  assert.equal(cmp.quotes.length, 1);
  assert.equal(cmp.quotes[0]?.expired, true);
});

test("awarding raises a draft order and keeps the losing quotes", async () => {
  const s = await scene();
  const cheap = await quote(s, s.cheapCo, [[s.lineA, 4], [s.lineB, 38]]);
  const dear = await quote(s, s.dearCo, [[s.lineA, 6], [s.lineB, 42]]);

  const { purchaseOrderId } = await awardQuote(s.c, cheap, "En düşük fiyat ve teslim uygun");
  const po = await s.qe.get(s.c, "purchaseOrder", purchaseOrderId);
  // A DRAFT: awarding is a purchasing decision; committing goes through the
  // order's own approval, and skipping it here would be a way around it.
  assert.equal(po.status, "draft");
  assert.equal(String(po.supplierId), s.cheapCo);

  const lines = await s.qe.listComplete(s.c, "purchaseOrderLine", {
    filters: [{ field: "poId", op: "eq", value: purchaseOrderId }],
  });
  assert.equal(lines.length, 2);
  // By description, not by position: `listComplete` returns rows in whatever
  // order the database chose, and asserting on `lines[0]` is a test that passes
  // in isolation and fails in a full run.
  const priceOf = (needle: string) =>
    Number(lines.find((l) => String(l.description).includes(needle))?.unitPrice ?? 0);
  assert.equal(priceOf("Vida"), 4);
  assert.equal(priceOf("kelepçe"), 38);

  const won = await s.qe.get(s.c, "supplierQuote", cheap);
  const lost = await s.qe.get(s.c, "supplierQuote", dear);
  assert.equal(won.status, "awarded");
  assert.equal(String(won.awardReason), "En düşük fiyat ve teslim uygun");
  // Kept, not deleted: they are the record of what the alternatives were.
  assert.equal(lost.status, "declined");
  assert.equal((await s.qe.get(s.c, "purchaseRequest", s.request)).status, "ordered");
});

test("an awarded quote becomes the agreed price for that supplier", async () => {
  const s = await scene();
  const cheap = await quote(s, s.cheapCo, [[s.lineA, 4]]);
  await awardQuote(s.c, cheap);
  const agreement = await priceFor(s.c, s.cheapCo, s.widget);
  assert.equal(Number(agreement?.unitPrice), 4, "the next reorder should not have to ask again");
});

test("lines the winner cannot supply are left off the order", async () => {
  const s = await scene();
  const partial = await quote(s, s.cheapCo, [[s.lineA, 4], [s.lineB, 0, true]]);
  const { purchaseOrderId } = await awardQuote(s.c, partial, "İkinci kalem başka tedarikçiden");
  const lines = await s.qe.listComplete(s.c, "purchaseOrderLine", {
    filters: [{ field: "poId", op: "eq", value: purchaseOrderId }],
  });
  assert.equal(lines.length, 1);
});

test("a quote offering nothing at all cannot be awarded", async () => {
  const s = await scene();
  const empty = await quote(s, s.cheapCo, [[s.lineA, 0, true], [s.lineB, 0, true]]);
  await assert.rejects(() => awardQuote(s.c, empty), /every line is marked unavailable/);
});

test("a request already ordered cannot be awarded again", async () => {
  const s = await scene();
  const first = await quote(s, s.cheapCo, [[s.lineA, 4]]);
  const second = await quote(s, s.dearCo, [[s.lineA, 6]]);
  await awardQuote(s.c, first);
  await assert.rejects(() => awardQuote(s.c, second), /already been ordered/);
});

test("a routine request can be ordered directly, priced from the agreement", async () => {
  // Insisting on a quote round for a box of paper is how a process stops being
  // used at all.
  const s = await scene();
  await s.qe.createWithComputed(
    s.c,
    "supplierProduct",
    { supplierId: s.cheapCo, productId: s.widget, unitPrice: 3.5, active: true },
    { supplyKey: `${s.cheapCo}:${s.widget}` },
  );

  const { purchaseOrderId } = await orderRequestDirect(s.c, s.request, s.cheapCo);
  const lines = await s.qe.listComplete(s.c, "purchaseOrderLine", {
    filters: [{ field: "poId", op: "eq", value: purchaseOrderId }],
  });
  const catalogued = lines.find((l) => String(l.productId) === s.widget);
  const oneOff = lines.find((l) => !l.productId);
  assert.equal(Number(catalogued?.unitPrice), 3.5, "from the agreement");
  // No agreement to read, so the requester's estimate stands in — a zero would
  // quietly become a zero-cost receipt.
  assert.equal(Number(oneOff?.unitPrice), 40, "from the estimate");
});

test("a request with no warehouse cannot be ordered", async () => {
  // A purchase order receives into somewhere; without one the receipt has
  // nowhere to put the goods.
  const s = await scene();
  await s.qe.patchComputed(s.c, "purchaseRequest", s.request, { warehouseId: null });
  const q = await quote(s, s.cheapCo, [[s.lineA, 4]]);
  await assert.rejects(() => awardQuote(s.c, q), /set a warehouse/);
});
