/**
 * Turkish VAT (KDV) rates.
 *
 * The statutory rates are a short, closed list — 20% general, 10% reduced (food,
 * textiles, some services), 1% basic (bread, certain agricultural goods), and 0%
 * for exempt or exported supplies. A line still stores a plain percentage, so
 * nothing here constrains what can be entered; this exists so the UI can offer
 * the legal choices and so a typo (a 2% line where 20% was meant) is visible
 * rather than silently accepted.
 *
 * Rates change by decree. When one does, edit this list — the values are not
 * derived from anything and no migration is needed, because lines have always
 * stored the number they were created with.
 */

export interface VatRate {
  /** The percentage, as stored on a document line. */
  rate: number;
  /** Turkish label, for the picker. */
  label: string;
  /** What it applies to — shown as help text, not enforced. */
  note: string;
}

export const VAT_RATES: readonly VatRate[] = [
  { rate: 20, label: "%20 (Genel)", note: "Genel oran" },
  { rate: 10, label: "%10 (İndirimli)", note: "Gıda, tekstil, bazı hizmetler" },
  { rate: 1, label: "%1 (Temel)", note: "Ekmek, bazı tarım ürünleri" },
  { rate: 0, label: "%0 (İstisna)", note: "İhracat ve istisna kapsamındaki teslimler" },
];

/** The rate applied when a line does not say otherwise. */
export const DEFAULT_VAT_RATE = 20;

/** Is this one of the statutory rates? Used to flag, never to reject. */
export function isStatutoryVatRate(rate: number): boolean {
  return VAT_RATES.some((r) => r.rate === rate);
}

/**
 * Split a period's VAT into what was charged and what may be deducted.
 *
 * `payable` is what is actually remitted. A negative figure is not a refund
 * cheque: under Turkish rules the excess (devreden KDV) carries forward to the
 * next period, which is why it is reported separately rather than folded into
 * `payable`.
 */
export interface VatSummary {
  /** 391 — VAT charged on sales. */
  output: number;
  /** 191 — VAT paid on purchases, deductible. */
  input: number;
  /** What is owed this period (0 when input exceeds output). */
  payable: number;
  /** Excess input VAT carried to the next period (devreden KDV). */
  carriedForward: number;
}

export function summariseVat(output: number, input: number): VatSummary {
  const round2 = (n: number): number => Math.round(n * 100) / 100 + 0;
  const net = round2(output - input);
  return {
    output: round2(output),
    input: round2(input),
    payable: net > 0 ? net : 0,
    carriedForward: net < 0 ? round2(-net) : 0,
  };
}
