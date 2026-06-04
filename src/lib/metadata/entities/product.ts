import type { EntityDef } from "../types";
import { CURRENCY_OPTIONS } from "./shared";

/** Phase F3 — product / price-book item. */
export const productEntity: EntityDef = {
  name: "product",
  label: "Product",
  pluralLabel: "Products",
  icon: "product",
  group: "finance",
  titleField: "name",
  fields: [
    { name: "name", label: "Name", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 160 },
    { name: "sku", label: "SKU", type: "string", unique: true, searchable: true, sortable: true },
    { name: "unitPrice", label: "Unit Price", type: "currency", required: true, sortable: true, min: 0 },
    { name: "currencyCode", label: "Currency", type: "enum", filterable: true, defaultValue: "USD", options: CURRENCY_OPTIONS },
    { name: "taxRate", label: "Tax Rate", type: "percent", defaultValue: 0, min: 0, max: 100 },
    { name: "active", label: "Active", type: "boolean", filterable: true, defaultValue: true },
  ],
  listColumns: [
    { field: "name", width: 240 },
    { field: "sku", width: 140 },
    { field: "unitPrice", width: 140 },
    { field: "currencyCode", width: 110 },
  ],
};
