/**
 * Currency conversion for the ledger.
 *
 * THE LEDGER IS KEPT IN ONE CURRENCY. Everything posted to it is expressed in
 * `BASE_CURRENCY`, and a document in any other currency is converted on the way
 * in, at the rate for its own date.
 *
 * That is not how it worked. `postings.ts` took the document's raw `total` and
 * posted it, so a EUR invoice and a lira invoice were added together as if they
 * were the same unit — a trial balance that summed 47,000 lira and 1,000 euro to
 * 48,000 of nothing. Nothing errored, because nothing was checking; the figures
 * simply stopped meaning anything the moment a second currency was used.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It does not invent a rate. A missing rate is an error the operator can fix,
 *    not a 1.0 that silently books a euro as a lira.
 *  - It does not convert at "today". An invoice is converted at the rate for the
 *    day it was raised, and that figure never changes afterwards — which is what
 *    makes a later gain or loss computable at all.
 */
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import { BadRequestError } from "@/lib/enforcement/errors";
import { cache } from "@/lib/cache/cache";
import { BASE_CURRENCY } from "@/lib/config/env";

const round2 = (n: number): number => Math.round(n * 100) / 100 + 0;

/** Rates change once a day at most; a short cache collapses a document's lookups. */
const TTL_MS = 60_000;

export interface Rate {
  currencyCode: string;
  rateDate: string;
  /** How many BASE units one unit of `currencyCode` is worth. */
  rate: number;
}

function key(ctx: RequestContext, code: string, onDate: string): string {
  return `fx:${ctx.tenantId}:${ctx.orgId}:${code}:${onDate}`;
}

/**
 * The rate to use for `currencyCode` on `onDate`.
 *
 * Takes the most recent rate ON OR BEFORE the date, rather than requiring an
 * exact match. Rates are not published on weekends or holidays, and a document
 * dated Sunday is not a reason to refuse to post — Friday's rate is the rate
 * that was in force. Looking forward would be worse than looking back: it would
 * value a March invoice at a figure nobody knew in March.
 *
 * Returns 1 for the base currency without a lookup: converting lira to lira is
 * not a question anyone should have to configure an answer to.
 */
export async function rateFor(ctx: RequestContext, currencyCode: string, onDate: string): Promise<number> {
  const code = (currencyCode || BASE_CURRENCY).toUpperCase();
  if (code === BASE_CURRENCY) return 1;
  const day = String(onDate).slice(0, 10);

  return cache.wrap(key(ctx, code, day), TTL_MS, async () => {
    const qe = await getQueryEngine();
    const page = await qe.list(ctx, "exchangeRate", {
      filters: [
        { field: "currencyCode", op: "eq", value: code },
        { field: "rateDate", op: "lte", value: day },
      ],
      sort: [{ field: "rateDate", dir: "desc" }],
      pageSize: 1,
    });
    const found = page.items[0];
    const rate = Number(found?.rate ?? 0);
    if (!found || !Number.isFinite(rate) || rate <= 0) {
      // Refused rather than defaulted. A 1.0 here would post a euro as a lira
      // and the books would balance perfectly while being wrong by a factor of
      // forty — the kind of error that is only found by someone noticing the
      // revenue looks low.
      throw new BadRequestError(
        `no exchange rate for ${code} on or before ${day} — add one in Finance → Exchange Rates before posting this document`,
      ).withKey("err.noFxRate", { code, day });
    }
    return rate;
  });
}

export interface Converted {
  /** The amount as the document states it. */
  amount: number;
  currencyCode: string;
  rate: number;
  /** The same amount in the ledger's currency. This is what gets posted. */
  base: number;
}

/** Convert one amount for a document dated `onDate`. */
export async function toBase(
  ctx: RequestContext,
  amount: number,
  currencyCode: string,
  onDate: string,
): Promise<Converted> {
  const code = (currencyCode || BASE_CURRENCY).toUpperCase();
  const rate = await rateFor(ctx, code, onDate);
  return { amount: round2(amount), currencyCode: code, rate, base: round2(amount * rate) };
}

/**
 * Convert several amounts at ONE rate.
 *
 * Every figure on a document must be converted at the same rate, or the
 * converted lines stop adding up to the converted total and the entry does not
 * balance. Fetching the rate once and applying it to each amount is what
 * guarantees that; converting each amount independently would look identical
 * and be correct only until the cache expired mid-document.
 */
export async function convertAll(
  ctx: RequestContext,
  amounts: Record<string, number>,
  currencyCode: string,
  onDate: string,
): Promise<{ rate: number; base: Record<string, number>; currencyCode: string }> {
  const code = (currencyCode || BASE_CURRENCY).toUpperCase();
  const rate = await rateFor(ctx, code, onDate);
  const base: Record<string, number> = {};
  for (const [k, v] of Object.entries(amounts)) base[k] = round2(v * rate);
  return { rate, base, currencyCode: code };
}

/** Is this document in the ledger's own currency? Then nothing needs converting. */
export function isBase(currencyCode: string | null | undefined): boolean {
  return !currencyCode || currencyCode.toUpperCase() === BASE_CURRENCY;
}

/**
 * The realised gain or loss when a foreign-currency balance is settled.
 *
 * An invoice for €1,000 raised at 47.0 puts 47,000 into receivables. Paid when
 * the rate is 48.0, the bank receives 48,000 — but the receivable only carried
 * 47,000, so 1,000 has to go somewhere or the entry does not balance. That
 * somewhere is a gain (646) or a loss (656); it is not a rounding difference and
 * it is not revenue.
 *
 * Positive = gain. Signed so the caller does not have to decide which account
 * from a magnitude and a comment.
 */
export function realisedFx(
  amountForeign: number,
  rateAtInvoice: number,
  rateAtSettlement: number,
): number {
  return round2(amountForeign * (rateAtSettlement - rateAtInvoice));
}
