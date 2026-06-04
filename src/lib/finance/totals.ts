/**
 * Phase F0 — deterministic document totals (quotes/invoices).
 *
 * `taxRate` is a percentage (e.g. 20 = 20%). Line and document totals are
 * rounded to 2 decimals. Used by the finance domain service to recompute the
 * computed fields whenever line items change.
 */
export interface LineInput {
  qty: number;
  unitPrice: number;
  /** Tax rate as a percentage. */
  taxRate: number;
}

export interface LineTotals {
  lineSubtotal: number;
  lineTax: number;
  lineTotal: number;
}

export interface DocTotals {
  subtotal: number;
  taxTotal: number;
  total: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function lineTotals(line: LineInput): LineTotals {
  const lineSubtotal = round2(line.qty * line.unitPrice);
  const lineTax = round2(lineSubtotal * (line.taxRate / 100));
  return { lineSubtotal, lineTax, lineTotal: round2(lineSubtotal + lineTax) };
}

export function docTotals(lines: LineInput[]): DocTotals {
  let subtotal = 0;
  let taxTotal = 0;
  for (const line of lines) {
    const t = lineTotals(line);
    subtotal += t.lineSubtotal;
    taxTotal += t.lineTax;
  }
  subtotal = round2(subtotal);
  taxTotal = round2(taxTotal);
  return { subtotal, taxTotal, total: round2(subtotal + taxTotal) };
}
