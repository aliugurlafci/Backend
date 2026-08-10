/**
 * Period-end revaluation of foreign-currency balances (kur değerlemesi).
 *
 * An open EUR receivable is carried at the rate it was booked at. At period end
 * that figure is stale: the balance sheet would report a receivable at a rate
 * nobody could get any more. VUK requires open foreign-currency balances to be
 * restated at the closing rate, and the difference is an unrealised gain or loss.
 *
 * THE ENTRY MUST BE REVERSED, and that is the whole design.
 *
 * The gain is unrealised — nothing was received. If it stayed on the books, the
 * receivable would carry the closing rate, and when the customer eventually pays
 * the realised difference would be computed against the ORIGINAL booking rate
 * and counted a second time. So the revaluation is posted on the last day of the
 * period and reversed on the first day of the next, leaving the receivable at
 * its booking rate for the settlement arithmetic to work from. That is the
 * standard treatment and it is not optional here — the realised calculation in
 * `postings.ts` reads the booking rate off the original entry, and a permanent
 * revaluation would silently make it wrong.
 */
import type { EntityRecord } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import { getAccountingService } from "./service";
import { logger } from "@/lib/observability/logger";
import { BASE_CURRENCY } from "@/lib/config/env";

const round2 = (n: number): number => Math.round(n * 100) / 100 + 0;

export interface RevaluationRow {
  documentType: "invoice" | "vendorBill";
  documentId: string;
  number: string;
  currencyCode: string;
  /** Still outstanding, in the document's currency. */
  openAmount: number;
  bookedRate: number;
  closingRate: number;
  /** Signed, in the ledger's currency. Positive = the balance is worth more. */
  difference: number;
}

export interface RevaluationResult {
  asOf: string;
  rows: RevaluationRow[];
  /** Net effect on receivables, in the ledger's currency. */
  receivableDifference: number;
  /** Net effect on payables. */
  payableDifference: number;
  posted: boolean;
}

/**
 * What each open foreign-currency document is worth at the closing rate.
 *
 * Report-only by default. Producing the numbers and posting them are separate
 * because the figures are reviewed before they reach the ledger — a revaluation
 * run against a wrong closing rate is a period-end correction nobody enjoys.
 */
export async function revalue(
  ctx: RequestContext,
  opts: { asOf: string; post?: boolean },
): Promise<RevaluationResult> {
  const qe = await getQueryEngine();
  const acc = await getAccountingService();
  const { rateFor, isBase } = await import("@/lib/finance/fx");
  const asOf = String(opts.asOf).slice(0, 10);

  const rows: RevaluationRow[] = [];

  /** Open documents of one kind, with their outstanding balance. */
  const collect = async (
    entity: "invoice" | "vendorBill",
    openStatuses: readonly string[],
  ): Promise<void> => {
    // `listComplete` rather than a page: a revaluation that silently saw only
    // the first page would understate the adjustment, and the figure it produced
    // would look entirely plausible.
    const docs = await qe.listComplete(ctx, entity, {
      filters: [{ field: "status", op: "in", value: [...openStatuses] }],
    });
    for (const doc of docs) {
      const currency = String(doc.currencyCode ?? BASE_CURRENCY);
      if (isBase(currency)) continue;
      // What is still owed, in the document's currency.
      const open = round2(Number(doc.balance ?? doc.total ?? 0));
      if (open <= 0) continue;

      const bookedRate = await bookedRateOf(ctx, entity, String(doc.id));
      if (!bookedRate) continue;
      const closingRate = await rateFor(ctx, currency, asOf);
      const difference = round2(open * (closingRate - bookedRate));
      if (difference === 0) continue;

      rows.push({
        documentType: entity,
        documentId: String(doc.id),
        number: String(doc.number ?? doc.id),
        currencyCode: currency,
        openAmount: open,
        bookedRate,
        closingRate,
        difference,
      });
    }
  };

  await collect("invoice", ["sent", "partial", "overdue", "issued"]);
  await collect("vendorBill", ["received", "approved", "partial", "overdue"]);

  const receivableDifference = round2(
    rows.filter((r) => r.documentType === "invoice").reduce((s, r) => s + r.difference, 0),
  );
  const payableDifference = round2(
    rows.filter((r) => r.documentType === "vendorBill").reduce((s, r) => s + r.difference, 0),
  );

  const result: RevaluationResult = {
    asOf,
    rows,
    receivableDifference,
    payableDifference,
    posted: false,
  };
  if (!opts.post || rows.length === 0) return result;

  const lines = [];
  // A receivable worth more is a gain; a payable worth more is a loss, because
  // more will have to be paid. Same movement, opposite meaning — the asymmetry
  // that `foreignSettlementLines` handles for realised differences.
  if (receivableDifference !== 0) {
    const ar = await acc.requireAccount(ctx, "accounts_receivable");
    lines.push(
      receivableDifference > 0
        ? { ledgerAccountId: ar, debit: receivableDifference }
        : { ledgerAccountId: ar, credit: -receivableDifference },
    );
  }
  if (payableDifference !== 0) {
    const ap = await acc.requireAccount(ctx, "accounts_payable");
    lines.push(
      payableDifference > 0
        ? { ledgerAccountId: ap, credit: payableDifference }
        : { ledgerAccountId: ap, debit: -payableDifference },
    );
  }

  const net = round2(receivableDifference - payableDifference);
  if (net !== 0) {
    lines.push(
      net > 0
        ? { ledgerAccountId: await acc.requireAccount(ctx, "fx_gain"), credit: net, description: "Kur değerlemesi (gerçekleşmemiş)" }
        : { ledgerAccountId: await acc.requireAccount(ctx, "fx_loss"), debit: -net, description: "Kur değerlemesi (gerçekleşmemiş)" },
    );
  }
  if (lines.length === 0) return result;

  await acc.postFromSource(ctx, {
    source: "fxRevaluation",
    sourceRef: asOf,
    currencyCode: BASE_CURRENCY,
    date: asOf,
    memo: `Kur değerlemesi ${asOf}`,
    branchId: null,
    lines,
  });

  // Reversed on the following day, in the same call. Doing it here rather than
  // leaving it for a later job is deliberate: an unreversed revaluation makes
  // every subsequent settlement double-count the difference, and "someone will
  // run the reversal" is not a control.
  const nextDay = new Date(Date.parse(`${asOf}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
  await acc.postFromSource(ctx, {
    source: "fxRevaluationReversal",
    sourceRef: asOf,
    currencyCode: BASE_CURRENCY,
    date: nextDay,
    memo: `Kur değerlemesi ters kaydı ${nextDay}`,
    branchId: null,
    lines: lines.map((l) => ({
      ledgerAccountId: l.ledgerAccountId,
      debit: l.credit,
      credit: l.debit,
      description: l.description,
    })),
  });

  logger.info("fx revaluation posted and reversed", {
    asOf,
    documents: rows.length,
    receivableDifference,
    payableDifference,
  });
  return { ...result, posted: true };
}

/** The rate a document's balance was booked at, read off its posting. */
async function bookedRateOf(ctx: RequestContext, source: string, sourceRef: string): Promise<number | null> {
  const qe = await getQueryEngine();
  const entries = await qe.list(ctx, "journalEntry", {
    filters: [
      { field: "source", op: "eq", value: source },
      { field: "sourceRef", op: "eq", value: sourceRef },
      { field: "status", op: "eq", value: "posted" },
    ],
    pageSize: 1,
  });
  const entry: EntityRecord | undefined = entries.items[0];
  if (!entry) return null;
  const lines = await qe.listComplete(ctx, "journalLine", {
    filters: [{ field: "entryId", op: "eq", value: String(entry.id) }],
  });
  const withRate = lines.find((l) => Number(l.exchangeRate ?? 0) > 0);
  return withRate ? Number(withRate.exchangeRate) : null;
}
