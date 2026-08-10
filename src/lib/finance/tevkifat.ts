/**
 * KDV tevkifatı — VAT withholding.
 *
 * On certain supplies (construction, cleaning, staffing, freight, scrap metal…)
 * the BUYER withholds a statutory fraction of the VAT and remits it to the tax
 * office directly. The seller invoices the full VAT for the record but collects
 * only the part not withheld.
 *
 * Concretely, at 5/10 on a ₺10.000 supply with 20% VAT:
 *
 *   matrah (base)        10.000
 *   hesaplanan KDV        2.000
 *   tevkifat (5/10)       1.000   ← the buyer pays this to the state
 *   tahsil edilecek       1.000   ← the seller collects this
 *   fatura toplamı       11.000   (10.000 + 1.000)
 *
 * The seller therefore declares only the non-withheld VAT in 391. Booking the
 * full 2.000 would overstate what is owed by exactly the withheld amount.
 *
 * Ratios are expressed as tenths because that is how the legislation and every
 * invoice template state them ("5/10", "7/10"), and rendering 0.5 back as "5/10"
 * for the printed fatura would be a lossy round trip.
 */

/** The statutory withholding ratios, in tenths. */
export const TEVKIFAT_RATIOS = [2, 3, 4, 5, 7, 9] as const;
export type TevkifatRatio = (typeof TEVKIFAT_RATIOS)[number];

const round2 = (n: number): number => Math.round(n * 100) / 100 + 0;

export interface TevkifatResult {
  /** VAT calculated on the base, before any withholding. */
  vatTotal: number;
  /** The part the buyer withholds and remits directly. */
  withheld: number;
  /** The part the seller collects and declares — what 391 is credited with. */
  collectible: number;
  /** Invoice total: base + collectible VAT. */
  documentTotal: number;
}

/**
 * Split VAT between what the buyer withholds and what the seller collects.
 *
 * `ratioTenths` of 0 (or absent) means no withholding, which is the ordinary
 * case — this must stay a no-op for every invoice that is not subject to it.
 *
 * The collectible part is derived by subtraction rather than computed
 * independently, so the two always sum to exactly `vatTotal` with no rounding
 * residual left between them.
 */
export function applyTevkifat(subtotal: number, vatTotal: number, ratioTenths = 0): TevkifatResult {
  const base = round2(subtotal);
  const vat = round2(vatTotal);

  if (!ratioTenths || ratioTenths <= 0) {
    return { vatTotal: vat, withheld: 0, collectible: vat, documentTotal: round2(base + vat) };
  }
  if (ratioTenths >= 10) {
    // 10/10 is full withholding: the seller collects no VAT at all.
    return { vatTotal: vat, withheld: vat, collectible: 0, documentTotal: base };
  }

  const withheld = round2((vat * ratioTenths) / 10);
  const collectible = round2(vat - withheld);
  return { vatTotal: vat, withheld, collectible, documentTotal: round2(base + collectible) };
}

/** "5/10" — how the ratio is written on the invoice and in the legislation. */
export function formatTevkifat(ratioTenths: number): string {
  return ratioTenths > 0 ? `${ratioTenths}/10` : "";
}
