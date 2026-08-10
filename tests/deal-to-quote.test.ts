/**
 * Opportunity → quote, the first link of the sales chain.
 *
 * The chain ran `quote → invoice → payment` with the pipeline sitting beside it
 * unconnected: a deal was worked up to `proposal` and whatever actually went to
 * the customer was a separate document nobody could trace back to it. So
 * "what did we quote on that opportunity?" had no answer, and the pipeline was
 * a CRM island rather than the start of the sell side.
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

const ctx = (): RequestContext => systemContext(TENANT_ID, ORG_ID);

let seq = 0;
async function opportunity(over: Record<string, unknown> = {}) {
  const qe = await getQueryEngine();
  const n = ++seq;
  const account = await qe.create(ctx(), "account", { name: `Customer ${n}` });
  const deal = await qe.create(ctx(), "deal", {
    name: `Warehouse racking ${n}`,
    accountId: String(account.id),
    amount: 12_500,
    stage: "proposal",
    ...over,
  });
  return { account, deal };
}

const quoteOf = async (id: string) => {
  const fin = await getFinanceService();
  return fin.getDocument(ctx(), "quote", "quoteLine", "quoteId", id);
};

test("a deal becomes a draft quote for the same customer", async () => {
  const { account, deal } = await opportunity();
  const fin = await getFinanceService();
  const quoteId = await fin.convertDealToQuote(ctx(), String(deal.id));

  const { doc } = await quoteOf(quoteId);
  assert.equal(String(doc.accountId), String(account.id));
  assert.equal(doc.status, "draft", "a conversion is a starting point, not something already sent");
});

test("the quote points back at the deal it came from", async () => {
  // The whole point: without this the two documents are unrelated records that
  // happen to name the same customer.
  const { deal } = await opportunity();
  const fin = await getFinanceService();
  const quoteId = await fin.convertDealToQuote(ctx(), String(deal.id));
  const { doc } = await quoteOf(quoteId);
  assert.equal(String(doc.dealId), String(deal.id));
});

test("the deal's amount seeds a line, so the quote is not a blank form", async () => {
  const { deal } = await opportunity();
  const fin = await getFinanceService();
  const { lines, doc } = await quoteOf(await fin.convertDealToQuote(ctx(), String(deal.id)));

  assert.equal(lines.length, 1);
  assert.equal(Number(lines[0]?.unitPrice), 12_500);
  assert.equal(String(lines[0]?.description), String(deal.name), "described by what the opportunity was called");
  assert.equal(Number(doc.total), 12_500, "and the header total follows from it");
});

test("a deal with no amount yet still converts", async () => {
  // An opportunity worth "we don't know" is exactly the one somebody is about
  // to quote. Refusing it would push them back to raising the quote by hand,
  // which is the disconnection this exists to remove.
  const { deal } = await opportunity({ amount: 0 });
  const fin = await getFinanceService();
  const { lines } = await quoteOf(await fin.convertDealToQuote(ctx(), String(deal.id)));
  assert.equal(Number(lines[0]?.unitPrice), 0);
});

test("a deal with no customer is refused rather than guessed at", async () => {
  const qe = await getQueryEngine();
  const deal = await qe.create(ctx(), "deal", { name: "Idea", amount: 100, stage: "lead" });
  const fin = await getFinanceService();
  await assert.rejects(() => fin.convertDealToQuote(ctx(), String(deal.id)), /no customer/);
});

test("converting does not move the deal's stage", async () => {
  // Creating a draft quote is not the same as having proposed anything — it has
  // not been sent. Advancing somebody's pipeline as a side effect of a button
  // labelled "create quote" is the kind of help that gets undone by hand.
  const { deal } = await opportunity({ stage: "qualified" });
  const fin = await getFinanceService();
  await fin.convertDealToQuote(ctx(), String(deal.id));
  const after = await (await getQueryEngine()).get(ctx(), "deal", String(deal.id));
  assert.equal(after.stage, "qualified");
});

test("converting twice yields two independent quotes", async () => {
  // Re-quoting an opportunity is ordinary — a revised offer after negotiation.
  // Neither the deal nor the first quote is disturbed by the second.
  const { deal } = await opportunity();
  const fin = await getFinanceService();
  const first = await fin.convertDealToQuote(ctx(), String(deal.id));
  const second = await fin.convertDealToQuote(ctx(), String(deal.id));
  assert.notEqual(first, second);
  const { doc: a } = await quoteOf(first);
  const { doc: b } = await quoteOf(second);
  assert.notEqual(String(a.number), String(b.number), "each gets its own document number");
});

test("converted quotes share the number series with directly-raised ones", async () => {
  // A separate prefix would split the numbering in two and make "quote 14"
  // ambiguous — there would be two of them.
  const { account, deal } = await opportunity();
  const fin = await getFinanceService();
  const direct = await fin.createDocument(ctx(), "quote", "Q", { accountId: String(account.id), status: "draft" });
  const converted = await quoteOf(await fin.convertDealToQuote(ctx(), String(deal.id)));
  const prefix = (n: unknown) => String(n).split("-")[0];
  assert.equal(prefix(converted.doc.number), prefix(direct.number));
});

test("the whole chain links up: deal → quote → invoice", async () => {
  // The end the change exists for. Each document names the one before it, so a
  // paid invoice can be walked back to the opportunity that started it.
  const { deal } = await opportunity();
  const fin = await getFinanceService();
  const quoteId = await fin.convertDealToQuote(ctx(), String(deal.id));
  const invoiceId = await fin.convertQuoteToInvoice(ctx(), quoteId);

  const qe = await getQueryEngine();
  const invoice = await qe.get(ctx(), "invoice", invoiceId);
  const quote = await qe.get(ctx(), "quote", quoteId);
  assert.equal(String(invoice.quoteId), quoteId);
  assert.equal(String(quote.dealId), String(deal.id));
  assert.equal(Number(invoice.total), 12_500, "the amount survives both hops");
});
