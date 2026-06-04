import type { EntityDef } from "../types";

/** Phase F4 — Quote line item (child of quote). Hidden from nav; managed via the
 *  quote editor. `lineTotal` is computed (qty × price + tax). */
export const quoteLineEntity: EntityDef = {
  name: "quoteLine",
  label: "Quote Line",
  pluralLabel: "Quote Lines",
  group: "finance",
  system: true,
  titleField: "description",
  parent: { entity: "quote", field: "quoteId" },
  fields: [
    { name: "quoteId", label: "Quote", type: "reference", referenceEntity: "quote", required: true, filterable: true },
    { name: "productId", label: "Product", type: "reference", referenceEntity: "product" },
    { name: "description", label: "Description", type: "string", required: true },
    { name: "qty", label: "Qty", type: "number", required: true, min: 0, defaultValue: 1 },
    { name: "unitPrice", label: "Unit Price", type: "currency", required: true, min: 0 },
    { name: "taxRate", label: "Tax %", type: "percent", defaultValue: 0, min: 0, max: 100 },
    { name: "lineTotal", label: "Line Total", type: "currency", computed: true },
  ],
};
