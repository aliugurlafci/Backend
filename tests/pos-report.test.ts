/**
 * The till report — X and Z.
 *
 * The session row tracked one number about the money: how much cash was taken.
 * Everything else collapsed into "not cash", so a cashier balancing the drawer
 * had no card total to compare against the terminal's own printout, and a float
 * top-up or a courier paid from the till surfaced at closing as a variance.
 *
 * Two properties under test:
 *
 *  - **X and Z agree.** They are the same arithmetic read at different moments.
 *    A cashier who checks at lunchtime must find the same figures at closing,
 *    or the X-report is worse than not having one.
 *  - **Expected cash accounts for what is not a sale.** Otherwise the variance
 *    is routinely wrong, and a control that is routinely wrong is one nobody
 *    reads.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import type { RequestContext } from "@/lib/context/types";

const { getQueryEngine } = await import("@/lib/data/store");
const { systemContext } = await import("@/lib/context/resolver");
const { TENANT_ID, ORG_ID } = await import("@/lib/config/env");
const { getPosService } = await import("@/lib/pos/service");
const { getInventoryService } = await import("@/lib/inventory/service");
const { sessionReport, recordMovement } = await import("@/lib/pos/report");

const ctx = (): RequestContext => systemContext(TENANT_ID, ORG_ID);

let seq = 0;

/** An open till with stock behind it. */
async function till(openingFloat = 200) {
  const qe = await getQueryEngine();
  const c = ctx();
  const n = ++seq;
  const branch = await qe.create(c, "branch", { name: `Şube ${n}`, code: `SB${n}` });
  const warehouse = await qe.create(c, "warehouse", { name: `PRW${n}`, code: `PRW${n}`, branchId: String(branch.id) });
  const product = await qe.create(c, "product", {
    name: `Ürün ${n}`,
    sku: `PR-${n}`,
    unitPrice: 100,
    taxRate: 20,
    trackStock: true,
  });
  const inventory = await getInventoryService();
  await inventory.writeMovement(c, {
    productId: String(product.id),
    warehouseId: String(warehouse.id),
    qty: 1000,
    unitCost: 40,
    type: "receipt",
    ref: `pr-seed-${n}`,
    refType: "adjustment",
    movedAt: c.at,
  });

  const pos = await getPosService();
  // One open session per cashier is the service's rule, and every test here runs
  // as the same system user — so the previous test's till has to be shut before
  // this one opens, or they all accumulate into the first session.
  const previous = await pos.currentSession(c);
  if (previous) await pos.closeSession(c, String(previous.id), Number(previous.expectedCash ?? 0));
  const session = await pos.openSession(c, {
    branchId: String(branch.id),
    warehouseId: String(warehouse.id),
    openingFloat,
  });
  return { c, qe, pos, warehouse: String(warehouse.id), branch: String(branch.id), product: String(product.id), session: String(session.id), n };
}

/** Ring up `qty` at 100 + 20% KDV, tendered as given. */
async function sell(
  s: Awaited<ReturnType<typeof till>>,
  qty: number,
  payments: { method: string; amount: number }[],
  taxRate = 20,
) {
  return s.pos.checkout(s.c, {
    branchId: s.branch,
    warehouseId: s.warehouse,
    sessionId: s.session,
    currencyCode: "TRY",
    lines: [{ productId: s.product, description: "satış", qty, unitPrice: 100, taxRate }],
    payments,
    idempotencyKey: `pr-${s.n}-${Math.round(qty * 1000)}-${payments.map((p) => p.method).join("")}`,
  });
}

test("takings are split by tender, not into cash and everything else", async () => {
  const s = await till();
  await sell(s, 1, [{ method: "cash", amount: 120 }]);
  await sell(s, 2, [{ method: "card", amount: 240 }]);
  await sell(s, 3, [{ method: "card", amount: 360 }]);

  const report = await sessionReport(s.c, s.session);
  const byMethod = new Map(report.tenders.map((t) => [t.method, t]));
  assert.equal(byMethod.get("cash")?.amount, 120);
  assert.equal(byMethod.get("card")?.amount, 600);
  assert.equal(byMethod.get("card")?.count, 2, "two card sales, not one lump");
  assert.equal(report.salesTotal, 720);
});

test("the tax is reported per rate, from the lines", async () => {
  // A sale can mix a 1% staple with a 20% item, and a header total cannot be
  // split back apart.
  const s = await till();
  await sell(s, 1, [{ method: "cash", amount: 120 }], 20);
  await sell(s, 2, [{ method: "cash", amount: 202 }], 1);

  const report = await sessionReport(s.c, s.session);
  const byRate = new Map(report.taxes.map((t) => [t.rate, t]));
  assert.equal(byRate.get(20)?.base, 100);
  assert.equal(byRate.get(20)?.tax, 20);
  assert.equal(byRate.get(1)?.base, 200);
  assert.equal(byRate.get(1)?.tax, 2);
});

test("expected cash is the float plus cash taken", async () => {
  const s = await till(200);
  await sell(s, 1, [{ method: "cash", amount: 120 }]);
  await sell(s, 1, [{ method: "card", amount: 120 }]);

  const report = await sessionReport(s.c, s.session);
  assert.equal(report.openingFloat, 200);
  // Only the cash sale: a card sale puts nothing in the drawer, and counting it
  // would make every till appear short by the day's card takings.
  assert.equal(report.expectedCash, 320);
});

test("change given is not cash in the drawer", async () => {
  const s = await till(200);
  // A 120 sale tendered with 200: 80 goes back to the customer.
  const sale = await sell(s, 1, [{ method: "cash", amount: 200 }]);
  assert.equal(sale.change, 80);

  const report = await sessionReport(s.c, s.session);
  assert.equal(report.expectedCash, 320, "float 200 + 120 kept, not + 200 tendered");
  // The tender line agrees, because `applyPayment` refuses to record more than
  // the outstanding balance — the change never becomes a payment row at all.
  assert.equal(report.tenders.find((t) => t.method === "cash")?.amount, 120);
});

test("a float top-up raises the expected cash instead of becoming a variance", async () => {
  const s = await till(200);
  await sell(s, 1, [{ method: "cash", amount: 120 }]);
  await recordMovement(s.c, s.session, { direction: "in", amount: 500, reason: "Kasadan bozuk para" });

  const report = await sessionReport(s.c, s.session);
  assert.equal(report.paidIn, 500);
  assert.equal(report.expectedCash, 820);
});

test("money paid out of the drawer lowers it", async () => {
  const s = await till(200);
  await sell(s, 1, [{ method: "cash", amount: 120 }]);
  await recordMovement(s.c, s.session, { direction: "out", amount: 150, reason: "Kurye ödemesi" });

  const report = await sessionReport(s.c, s.session);
  assert.equal(report.paidOut, 150);
  assert.equal(report.expectedCash, 170);
  assert.equal(report.movements.length, 1);
  assert.equal(String(report.movements[0]?.reason), "Kurye ödemesi");
});

test("closing a till with the drawer movements accounted for reconciles to zero", async () => {
  const s = await till(200);
  await sell(s, 1, [{ method: "cash", amount: 120 }]);
  await sell(s, 2, [{ method: "card", amount: 240 }]);
  await recordMovement(s.c, s.session, { direction: "out", amount: 50, reason: "Kurye" });

  // 200 float + 120 cash − 50 out = 270 in the drawer.
  await s.pos.closeSession(s.c, s.session, 270);
  const z = await sessionReport(s.c, s.session, "z");
  assert.equal(z.countedCash, 270);
  assert.equal(z.variance, 0, "no phantom variance from the courier payment");
});

test("an X-report shows no variance against an uncounted drawer", async () => {
  // Mid-shift nothing has been counted, and printing a variance against a zero
  // count would read as the till being empty.
  const s = await till(200);
  await sell(s, 1, [{ method: "cash", amount: 120 }]);

  const x = await sessionReport(s.c, s.session, "x");
  assert.equal(x.kind, "x");
  assert.equal(x.countedCash, 0);
  assert.equal(x.variance, 0);
  assert.equal(x.expectedCash, 320, "but the expected figure is real");
});

test("X and Z report the same takings", async () => {
  // The property that makes an X-report worth trusting.
  const s = await till(200);
  await sell(s, 1, [{ method: "cash", amount: 120 }]);
  await sell(s, 2, [{ method: "card", amount: 240 }]);

  const x = await sessionReport(s.c, s.session, "x");
  await s.pos.closeSession(s.c, s.session, 320);
  const z = await sessionReport(s.c, s.session, "z");

  assert.equal(x.salesTotal, z.salesTotal);
  assert.equal(x.taxTotal, z.taxTotal);
  assert.equal(x.expectedCash, z.expectedCash);
  assert.deepEqual(
    x.tenders.map((t) => [t.method, t.amount]),
    z.tenders.map((t) => [t.method, t.amount]),
  );
});

test("a cash movement is refused on a closed till", async () => {
  const s = await till(200);
  await s.pos.closeSession(s.c, s.session, 200);
  await assert.rejects(
    () => recordMovement(s.c, s.session, { direction: "in", amount: 50, reason: "geç" }),
    /till is closed/,
  );
});

test("a zero or negative movement is refused", async () => {
  const s = await till(200);
  await assert.rejects(
    () => recordMovement(s.c, s.session, { direction: "in", amount: 0, reason: "boş" }),
    /positive amount/,
  );
});

test("an empty shift reports zeroes rather than failing", async () => {
  const s = await till(500);
  const report = await sessionReport(s.c, s.session);
  assert.equal(report.saleCount, 0);
  assert.equal(report.salesTotal, 0);
  assert.deepEqual(report.tenders, []);
  assert.equal(report.expectedCash, 500, "just the float");
});
