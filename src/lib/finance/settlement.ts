/**
 * Which ledger account a payment settles into.
 *
 * Every payment method used to post to one account, so a banknote handed over at
 * the till and a wire transfer landed in the same place — the books said the
 * money was in the bank the moment it went into the drawer, and 100 Kasa never
 * moved at all.
 *
 * Under Tekdüzen these are genuinely different assets, not presentation
 * variants:
 *
 *   100 Kasa                — cash in hand
 *   101 Alınan Çekler       — customer cheques held; not money until they clear
 *   102 Bankalar            — bank balances (transfer, card settlement)
 *   103 Verilen Çekler      — our own cheques issued, not yet presented
 *   121 Alacak Senetleri    — promissory notes receivable
 *   321 Borç Senetleri      — promissory notes payable
 *
 * A cheque is deliberately NOT treated as cash on receipt. It becomes cash when
 * it clears, and it can bounce — which is a state the ledger has to be able to
 * express. See the `cheque` entity's lifecycle.
 */

/** Payment methods the customer/vendor side can settle with. */
export type PaymentMethod = "cash" | "bank" | "card" | "cheque" | "note" | "other";

/**
 * The account subtype an INBOUND payment (from a customer) debits.
 *
 * `card` settles to the bank: the acquirer pays out to the account, not to the
 * till. Same-day or not, it is never cash in hand.
 */
export function inboundSettlementSubtype(method: string): string {
  switch (method) {
    case "cash":
      return "cash_register";
    case "cheque":
      return "cheques_received";
    case "note":
      return "notes_receivable";
    case "bank":
    case "card":
      return "cash"; // 102 Bankalar
    default:
      // An unrecognised method settles to the bank rather than failing the
      // posting: a payment that reached us is better recorded imprecisely than
      // not recorded at all, and the method is visible on the entry.
      return "cash";
  }
}

/** The account subtype an OUTBOUND payment (to a vendor) credits. */
export function outboundSettlementSubtype(method: string): string {
  switch (method) {
    case "cash":
      return "cash_register";
    case "cheque":
      return "cheques_issued";
    case "note":
      return "notes_payable";
    case "bank":
    case "card":
      return "cash"; // 102 Bankalar
    default:
      return "cash";
  }
}

/**
 * Does this method settle immediately, or does it create an instrument that has
 * to be collected later?
 *
 * Cheques and notes are the latter: the receivable moves from "customer owes us"
 * to "we hold a cheque", and only clears to cash on its own schedule.
 */
export function isDeferredInstrument(method: string): boolean {
  return method === "cheque" || method === "note";
}
