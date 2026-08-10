/**
 * Çek / senet postings.
 *
 * A cheque received is already in 101 (the payment that created it settled
 * there — see `lib/finance/settlement`). What happens afterwards is what this
 * file records:
 *
 *   clear   — the bank honoured it: 101/121 becomes 102 Bankalar.
 *   bounce  — it came back unpaid (karşılıksız): the instrument is written off
 *             and the customer receivable is restored, because no money ever
 *             arrived. This is the case a "cheque = cash on receipt" model
 *             cannot express at all.
 *   endorse — handed to a supplier in settlement (ciro): the instrument leaves
 *             the portfolio and reduces what we owe.
 *
 * Outbound instruments mirror this: our own cheque clearing moves 103 Verilen
 * Çekler to 102 Bankalar.
 *
 * Every posting is idempotent on (source, sourceRef) like the rest of the GL, so
 * a retried transition never double-posts.
 */
import type { EntityRecord } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import { AccountingError, getAccountingService, type JournalLineInput } from "./service";
import { BASE_CURRENCY } from "@/lib/config/env";

const round2 = (n: number): number => Math.round(n * 100) / 100;
const today = (ctx: RequestContext): string => ctx.at.slice(0, 10);

/** The account an instrument sits in while it is outstanding. */
function holdingSubtype(cheque: EntityRecord): string {
  const outbound = String(cheque.direction) === "outbound";
  const isNote = String(cheque.instrument) === "note";
  if (outbound) return isNote ? "notes_payable" : "cheques_issued";
  return isNote ? "notes_receivable" : "cheques_received";
}

function amountOf(cheque: EntityRecord): number {
  const amount = round2(Number(cheque.amount ?? 0));
  if (amount <= 0) throw new AccountingError("a cheque/note must carry a positive amount");
  return amount;
}

/**
 * The bank honoured it.
 *
 * Inbound: Dr 102 Bankalar, Cr 101/121 — the instrument becomes money.
 * Outbound: Dr 103/321, Cr 102 Bankalar — our cheque was presented and paid.
 */
export async function postChequeCleared(ctx: RequestContext, chequeId: string): Promise<void> {
  const qe = await getQueryEngine();
  const acc = await getAccountingService();
  const cheque = await qe.get(ctx, "cheque", chequeId);
  const amount = amountOf(cheque);
  const holding = await acc.requireAccount(ctx, holdingSubtype(cheque));
  const bank = await acc.requireAccount(ctx, "cash");
  const outbound = String(cheque.direction) === "outbound";

  const lines: JournalLineInput[] = outbound
    ? [
        { ledgerAccountId: holding, debit: amount },
        { ledgerAccountId: bank, credit: amount },
      ]
    : [
        { ledgerAccountId: bank, debit: amount },
        { ledgerAccountId: holding, credit: amount },
      ];

  await acc.postFromSource(ctx, {
    source: "chequeCleared",
    currencyCode: String(cheque.currencyCode ?? BASE_CURRENCY),
    sourceRef: chequeId,
    date: String(cheque.dueDate ?? today(ctx)),
    memo: `Tahsil: ${String(cheque.number)}`,
    branchId: (cheque.branchId as string) ?? null,
    lines,
  });
}

/**
 * Returned unpaid — karşılıksız.
 *
 * The instrument is removed from the portfolio and the debt goes back where it
 * came from: Dr 120 Alıcılar, Cr 101/121. The customer owes us again, which is
 * the whole reason a cheque is not booked as cash on receipt.
 *
 * An outbound instrument that bounces is our own failure to pay: the payable
 * returns instead (Dr 103/321, Cr 320 Satıcılar).
 */
export async function postChequeBounced(ctx: RequestContext, chequeId: string): Promise<void> {
  const qe = await getQueryEngine();
  const acc = await getAccountingService();
  const cheque = await qe.get(ctx, "cheque", chequeId);
  const amount = amountOf(cheque);
  const holding = await acc.requireAccount(ctx, holdingSubtype(cheque));
  const outbound = String(cheque.direction) === "outbound";
  const counterparty = await acc.requireAccount(ctx, outbound ? "accounts_payable" : "accounts_receivable");

  const lines: JournalLineInput[] = outbound
    ? [
        { ledgerAccountId: holding, debit: amount },
        { ledgerAccountId: counterparty, credit: amount },
      ]
    : [
        { ledgerAccountId: counterparty, debit: amount },
        { ledgerAccountId: holding, credit: amount },
      ];

  await acc.postFromSource(ctx, {
    source: "chequeBounced",
    currencyCode: String(cheque.currencyCode ?? BASE_CURRENCY),
    sourceRef: chequeId,
    date: today(ctx),
    memo: `Karşılıksız: ${String(cheque.number)}`,
    branchId: (cheque.branchId as string) ?? null,
    lines,
  });
}

/**
 * Endorsed to a supplier in settlement — ciro.
 *
 * The instrument leaves the portfolio and settles a payable:
 * Dr 320 Satıcılar, Cr 101/121. Only meaningful for an inbound instrument —
 * endorsing one we issued ourselves is not a thing.
 */
export async function postChequeEndorsed(ctx: RequestContext, chequeId: string): Promise<void> {
  const qe = await getQueryEngine();
  const acc = await getAccountingService();
  const cheque = await qe.get(ctx, "cheque", chequeId);
  if (String(cheque.direction) === "outbound") {
    throw new AccountingError("an issued cheque cannot be endorsed");
  }
  const amount = amountOf(cheque);

  await acc.postFromSource(ctx, {
    source: "chequeEndorsed",
    currencyCode: String(cheque.currencyCode ?? BASE_CURRENCY),
    sourceRef: chequeId,
    date: today(ctx),
    memo: `Ciro: ${String(cheque.number)}`,
    branchId: (cheque.branchId as string) ?? null,
    lines: [
      { ledgerAccountId: await acc.requireAccount(ctx, "accounts_payable"), debit: amount },
      { ledgerAccountId: await acc.requireAccount(ctx, holdingSubtype(cheque)), credit: amount },
    ],
  });
}
