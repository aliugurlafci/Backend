/**
 * Phase F0 — money formatting + currency conversion.
 *
 * A currency's `rate` is how many BASE units one unit is worth (USD base ⇒
 * EUR rate 1.08 means 1 EUR = 1.08 USD). `toBase` normalizes amounts so reports
 * can aggregate across currencies.
 */
export const BASE_CURRENCY = "USD";

export function formatMoney(amount: number, code: string = BASE_CURRENCY): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}

export function toBase(amount: number, rate: number): number {
  return Math.round(amount * rate * 100) / 100;
}
