import type { EntityDef } from "../types";

/** Phase F5 — Invoice line item (child of invoice). */
export const invoiceLineEntity: EntityDef = {
  name: "invoiceLine",
  label: "Invoice Line",
  pluralLabel: "Invoice Lines",
  group: "finance",
  system: true,
  titleField: "description",
  parent: { entity: "invoice", field: "invoiceId" },
  fields: [
    { name: "invoiceId", label: "Invoice", type: "reference", referenceEntity: "invoice", required: true, filterable: true },
    { name: "productId", label: "Product", type: "reference", referenceEntity: "product" },
    { name: "description", label: "Description", type: "string", required: true },
    { name: "qty", label: "Qty", type: "number", required: true, min: 0, defaultValue: 1 },
    { name: "unitPrice", label: "Unit Price", type: "currency", required: true, min: 0 },
    { name: "taxRate", label: "Tax %", type: "percent", defaultValue: 0, min: 0, max: 100 },
    { name: "lineTotal", label: "Line Total", type: "currency", computed: true },
  ],
};
