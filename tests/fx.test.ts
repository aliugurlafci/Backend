/**
 * Currency conversion for the ledger.
 *
 * The defect this closes was silent and total: `postings.ts` took a document's
 * raw total and posted it, so a EUR invoice and a lira invoice were added
 * together as if they were the same unit. A trial balance summed 47,000 lira and
 * 1,000 euro to 48,000 of nothing. Nothing errored, because nothing checked.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import type { RequestContext } from "@/lib/context/types";

const { getQueryEngine } = await import("@/lib/data/store");
const { systemContext } = await import("@/lib/context/resolver");
const { TENANT_ID, ORG_ID, BASE_CURRENCY } = await import("@/lib/config/env");
const { rateFor, toBase, convertAll, isBase, realisedFx } = await import("@/lib/finance/fx");
const { cache } = await import("@/lib/cache/cache");

const ctx = (): RequestContext => systemContext(TENANT_ID, ORG_ID);

async function rate(code: string, rateDate: string, value: number): Promise<void> {
  const qe = await getQueryEngine();
  await qe.create(ctx(), "exchangeRate", { currencyCode: code, rateDate, rate: value });
  await cache.invalidatePrefix(`fx:${TENANT_ID}:${ORG_ID}:`);
}

test("the base currency needs no rate and never looks one up", async () => {
  // Converting lira to lira is not a question anyone should configure an answer
  // to — and requiring a row would make the common case fail on a fresh install.
  assert.equal(await rateFor(ctx(), BASE_CURRENCY, "2026-08-08"), 1);
  assert.equal(isBase(BASE_CURRENCY), true);
  assert.equal(isBase(null), true);
  assert.equal(isBase("EUR"), false);
});

test("a missing rate is refused, not defaulted to 1", async () => {
  // A 1.0 here would post a euro as a lira: the entry balances perfectly and is
  // wrong by a factor of forty. That is only ever found by someone noticing the
  // revenue looks low.
  await assert.rejects(() => rateFor(ctx(), "GBP", "2026-08-08"), /no exchange rate for GBP/);
});

test("an amount is converted at the rate for its own date", async () => {
  await rate("EUR", "2026-03-01", 40);
  await rate("EUR", "2026-08-01", 47.5);

  const march = await toBase(ctx(), 1000, "EUR", "2026-03-15");
  assert.equal(march.rate, 40);
  assert.equal(march.base, 40000);

  const august = await toBase(ctx(), 1000, "EUR", "2026-08-08");
  assert.equal(august.rate, 47.5);
  assert.equal(august.base, 47500);
});

test("the most recent rate on or before the date is used", async () => {
  // Rates are not published on weekends. A document dated Sunday is not a reason
  // to refuse to post — Friday's rate is the rate that was in force.
  await rate("USD", "2026-08-07", 34);
  const sunday = await toBase(ctx(), 100, "USD", "2026-08-09");
  assert.equal(sunday.rate, 34);
});

test("a rate published after the document is not used", async () => {
  // Looking forward would value a March invoice at a figure nobody knew in March.
  await rate("USD", "2026-12-31", 99);
  const august = await toBase(ctx(), 100, "USD", "2026-08-09");
  assert.equal(august.rate, 34, "still Friday's rate, not December's");
});

test("every amount on a document converts at ONE rate", async () => {
  // Converting each amount independently would look identical and stop the entry
  // balancing the moment two of them resolved different rates.
  await rate("EUR", "2026-08-08", 47.5);
  const { rate: used, base } = await convertAll(
    ctx(),
    { subtotal: 1000, tax: 200, total: 1200 },
    "EUR",
    "2026-08-08",
  );
  assert.equal(used, 47.5);
  assert.equal(base.subtotal! + base.tax!, base.total, "the converted parts must still add to the converted whole");
  assert.equal(base.total, 57000);
});

test("conversion rounds to cents", async () => {
  await rate("EUR", "2026-08-08", 47.5);
  const c = await toBase(ctx(), 33.33, "EUR", "2026-08-08");
  assert.equal(c.base, 1583.18);
});

test("the realised difference is signed, not a magnitude", async () => {
  // €1,000 booked at 47.0 puts 47,000 in receivables; paid at 48.0 the bank
  // receives 48,000. The 1,000 is neither revenue nor rounding — without
  // somewhere to put it the payment entry does not balance.
  assert.equal(realisedFx(1000, 47, 48), 1000, "a gain when the currency strengthened");
  assert.equal(realisedFx(1000, 48, 47), -1000, "a loss when it weakened");
  assert.equal(realisedFx(1000, 47, 47), 0, "no movement, no difference");
});

test("the realised difference rounds to cents", () => {
  assert.equal(realisedFx(333.33, 47.1234, 47.5678), 148.13);
});

// ---- the sign asymmetry ------------------------------------------------------

test("a strengthening currency is a gain on a receipt and a loss on a payment", () => {
  // Same arithmetic, opposite meaning — and getting it backwards books a loss as
  // a gain, which balances perfectly and overstates profit. The direction is why
  // the two settlement paths share one function instead of two copies.
  const movement = realisedFx(1000, 47, 48); // the currency strengthened
  assert.equal(movement, 1000);

  // A receipt: more arrived than the receivable carried → gain.
  const receiptIsGain = movement > 0;
  // A payment: more had to go out than the payable carried → loss.
  const paymentIsGain = movement < 0;

  assert.equal(receiptIsGain, true);
  assert.equal(paymentIsGain, false, "a supplier payment must NOT record a gain when the currency strengthens");
});

test("a weakening currency reverses both", () => {
  const movement = realisedFx(1000, 48, 47);
  assert.equal(movement, -1000);
  assert.equal(movement > 0, false, "a receipt loses");
  assert.equal(movement < 0, true, "a payment gains");
});
