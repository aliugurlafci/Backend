/**
 * Deterministic document totals (quotes / invoices / orders / carts).
 *
 * `taxRate` is a percentage (20 = 20%). Every amount is rounded to 2 decimals.
 * Used by the finance service to recompute the computed fields whenever line
 * items change, and — through `docTotals` — by everything that reports money.
 *
 * DISCOUNT ORDER MATTERS, and it is a tax rule rather than a preference. KDV is
 * charged on the *matrah*: the amount actually invoiced after discount. So a
 * discount reduces the taxable base first and the tax follows it down. Applying
 * tax to the list price and discounting the gross afterwards produces the same
 * document total in the simple case and the WRONG tax figure in every case —
 * and the tax figure is the one that goes on the KDV return.
 */
export interface LineInput {
  qty: number;
  unitPrice: number;
  /** Tax rate as a percentage. */
  taxRate: number;
  /**
   * Per-line discount as a percentage of the line's gross.
   *
   * The common form on a Turkish invoice ("iskonto %10") and the one that
   * survives a quantity change: an absolute discount tied to 10 units becomes
   * wrong the moment someone edits the line to 8.
   */
  discountRate?: number;
  /**
   * Per-line discount as an absolute amount, applied after `discountRate`.
   *
   * For the negotiated case — "call it 500 lira off" — where a percentage would
   * be a rounded approximation of a number both sides already agreed.
   */
  discountAmount?: number;
}

export interface LineTotals {
  /** Gross before discount — qty × unit price. */
  lineGross: number;
  /** What the discount actually removed, after both forms are applied. */
  lineDiscount: number;
  /** The taxable base: gross − discount. This is the matrah. */
  lineSubtotal: number;
  lineTax: number;
  lineTotal: number;
}

export interface DocTotals {
  /** Sum of line gross, before any discount. */
  grossSubtotal: number;
  /** Line discounts plus the apportioned header discount. */
  discountTotal: number;
  /** Taxable base after all discounts. */
  subtotal: number;
  taxTotal: number;
  total: number;
}

export interface DocOptions {
  /** Document-level discount percentage, applied on top of any line discounts. */
  discountRate?: number;
  /** Document-level absolute discount, applied after `discountRate`. */
  discountAmount?: number;
}

function round2(n: number): number {
  // `+ 0` normalises -0, which otherwise reaches a currency column and reads as
  // a negative zero in reports.
  return Math.round(n * 100) / 100 + 0;
}

/**
 * Coerce a line field to a finite number.
 *
 * These totals are written straight into currency columns. A line posted
 * without a `taxRate` produced `undefined / 100` = NaN, which mysql2
 * interpolates as the bare token `NaN` and MySQL then rejects as an unknown
 * column — an error three layers from its cause. Request bodies are validated
 * now, but this stays: it also guards the internal callers, which are not.
 */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Clamp a discount so it can never exceed what is being discounted. */
function clampDiscount(discount: number, of: number): number {
  if (discount <= 0) return 0;
  return Math.min(round2(discount), of);
}

export function lineTotals(line: LineInput): LineTotals {
  const lineGross = round2(num(line.qty) * num(line.unitPrice));

  // Percentage first, then the absolute amount off what remains. The other order
  // makes "10% off, then 50 lira off" mean something different from what a
  // person reading the line expects, and neither order is arguable once written
  // down — so it is written down.
  const rate = Math.min(Math.max(num(line.discountRate), 0), 100);
  const byRate = round2((lineGross * rate) / 100);
  const byAmount = clampDiscount(num(line.discountAmount), round2(lineGross - byRate));
  const lineDiscount = round2(byRate + byAmount);

  // Never negative. A discount larger than the line is a data-entry mistake, and
  // a negative taxable base would post a debit where a credit belongs and
  // quietly reverse part of an invoice.
  const lineSubtotal = Math.max(0, round2(lineGross - lineDiscount));
  const lineTax = round2(lineSubtotal * (num(line.taxRate) / 100));
  return { lineGross, lineDiscount, lineSubtotal, lineTax, lineTotal: round2(lineSubtotal + lineTax) };
}

/**
 * Document totals, including a header-level discount.
 *
 * The header discount is APPORTIONED ACROSS THE LINES rather than subtracted
 * from the total. That is the whole difficulty, and it is not optional: lines
 * can carry different KDV rates, so a lump sum taken off the bottom has no
 * defined rate and the tax cannot be computed from it. Spreading it in
 * proportion to each line's taxable base keeps every line's rate intact and
 * makes the tax total the sum of correctly-rated parts.
 *
 * The last line absorbs the rounding remainder, so the apportioned parts always
 * add back to exactly the discount that was given — a cent adrift here becomes a
 * document whose lines do not sum to its own total.
 */
export function docTotals(lines: LineInput[], opts: DocOptions = {}): DocTotals {
  const computed = lines.map(lineTotals);

  const grossSubtotal = round2(computed.reduce((sum, t) => sum + t.lineGross, 0));
  const lineDiscountTotal = round2(computed.reduce((sum, t) => sum + t.lineDiscount, 0));
  const afterLineDiscounts = round2(computed.reduce((sum, t) => sum + t.lineSubtotal, 0));

  const headerRate = Math.min(Math.max(num(opts.discountRate), 0), 100);
  const headerByRate = round2((afterLineDiscounts * headerRate) / 100);
  const headerByAmount = clampDiscount(num(opts.discountAmount), round2(afterLineDiscounts - headerByRate));
  const headerDiscount = round2(headerByRate + headerByAmount);

  let subtotal = 0;
  let taxTotal = 0;

  if (headerDiscount <= 0 || afterLineDiscounts <= 0) {
    for (const t of computed) {
      subtotal += t.lineSubtotal;
      taxTotal += t.lineTax;
    }
  } else {
    let apportioned = 0;
    computed.forEach((t, i) => {
      const isLast = i === computed.length - 1;
      // The last line takes whatever is left, so rounding cannot lose or invent
      // a cent relative to the discount actually granted.
      const share = isLast
        ? round2(headerDiscount - apportioned)
        : round2((headerDiscount * t.lineSubtotal) / afterLineDiscounts);
      apportioned = round2(apportioned + share);
      const base = Math.max(0, round2(t.lineSubtotal - share));
      subtotal += base;
      // Recomputed from the reduced base at the LINE's own rate — which is why
      // the discount had to be apportioned rather than taken off the bottom.
      taxTotal += round2(base * (t.lineTax > 0 ? t.lineTax / t.lineSubtotal : 0));
    });
  }

  subtotal = round2(subtotal);
  taxTotal = round2(taxTotal);
  return {
    grossSubtotal,
    discountTotal: round2(lineDiscountTotal + headerDiscount),
    subtotal,
    taxTotal,
    total: round2(subtotal + taxTotal),
  };
}
