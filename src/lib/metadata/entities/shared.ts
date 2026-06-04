import type { EnumOption } from "../types";

/** Currency codes used across products, quotes and invoices (multi-currency). */
export const CURRENCY_OPTIONS: EnumOption[] = [
  { value: "USD", label: "USD ($)" },
  { value: "EUR", label: "EUR (€)" },
  { value: "GBP", label: "GBP (£)" },
  { value: "TRY", label: "TRY (₺)" },
];
