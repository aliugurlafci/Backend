import type { EnumOption, FieldDef } from "../types";

/** Currency codes used across products, quotes and invoices (multi-currency). */
export const CURRENCY_OPTIONS: EnumOption[] = [
  { value: "USD", label: "USD ($)" },
  { value: "EUR", label: "EUR (€)" },
  { value: "GBP", label: "GBP (£)" },
  { value: "TRY", label: "TRY (₺)" },
];

/**
 * Shared field builders for the document entities (quote/invoice/PO/vendor-bill/
 * goods-receipt headers and their line items). These return the exact field
 * shapes the entities used to inline, so the generated schema/behaviour is
 * unchanged — they only remove the heavy duplication across those definitions.
 */

/** Service-assigned, read-only document number (label varies per document). */
export function numberField(label = "Number"): FieldDef {
  return { name: "number", label, type: "string", readOnly: true, searchable: true, sortable: true };
}

/** Multi-currency selector (defaults to USD). */
export function currencyField(): FieldDef {
  return { name: "currencyCode", label: "Currency", type: "enum", defaultValue: "USD", options: CURRENCY_OPTIONS };
}

/** Branch reference (filterable). */
export function branchRef(): FieldDef {
  return { name: "branchId", label: "Branch", type: "reference", referenceEntity: "branch", filterable: true };
}

/** Dealer reference (filterable). */
export function dealerRef(): FieldDef {
  return { name: "dealerId", label: "Dealer", type: "reference", referenceEntity: "dealer", filterable: true };
}

/** Free-text notes. */
export function notesField(): FieldDef {
  return { name: "notes", label: "Notes", type: "text" };
}

/** Computed money triplet for line-summed documents. */
export function moneyTotals(): FieldDef[] {
  return [
    { name: "subtotal", label: "Subtotal", type: "currency", computed: true },
    { name: "taxTotal", label: "Tax", type: "currency", computed: true },
    { name: "total", label: "Total", type: "currency", computed: true, sortable: true },
  ];
}

/** Computed paid/balance pair for billed documents (invoice / vendor bill). */
export function paidBalance(): FieldDef[] {
  return [
    { name: "amountPaid", label: "Paid", type: "currency", computed: true },
    { name: "balance", label: "Balance", type: "currency", computed: true, sortable: true },
  ];
}

export interface PriceLineOptions {
  /** Parent reference field, e.g. `quoteId` → quote. */
  parentField: string;
  parentLabel: string;
  parentEntity: string;
  /** Procurement lines index the product; sales lines do not. */
  productFilterable?: boolean;
  /** Sales lines label it "Qty"; procurement lines "Quantity". */
  qtyLabel?: string;
  /** Sales lines default qty to 1; procurement lines have no default. */
  qtyDefault?: number;
  /** Sales lines label it "Tax %"; procurement lines "Tax Rate". */
  taxLabel?: string;
  /** Purchase-order lines track received quantity. */
  withQtyReceived?: boolean;
}

/** The "priced line item" field set shared by quote/invoice/PO/vendor-bill lines. */
export function priceLineFields(o: PriceLineOptions): FieldDef[] {
  const product: FieldDef = { name: "productId", label: "Product", type: "reference", referenceEntity: "product" };
  if (o.productFilterable) product.filterable = true;

  const qty: FieldDef = { name: "qty", label: o.qtyLabel ?? "Qty", type: "number", required: true, min: 0 };
  if (o.qtyDefault !== undefined) qty.defaultValue = o.qtyDefault;

  const fields: FieldDef[] = [
    { name: o.parentField, label: o.parentLabel, type: "reference", referenceEntity: o.parentEntity, required: true, filterable: true },
    product,
    { name: "description", label: "Description", type: "string", required: true },
    qty,
    { name: "unitPrice", label: "Unit Price", type: "currency", required: true, min: 0 },
    { name: "taxRate", label: o.taxLabel ?? "Tax %", type: "percent", defaultValue: 0, min: 0, max: 100 },
  ];
  if (o.withQtyReceived) fields.push({ name: "qtyReceived", label: "Received", type: "number", computed: true });
  fields.push({ name: "lineTotal", label: "Line Total", type: "currency", computed: true });
  return fields;
}
