import type { EntityDef } from "../types";
import { CURRENCY_OPTIONS } from "./shared";

/** Product / price-book + inventory item. `trackStock` gates stock movements and
 *  purchasing; `costPrice` drives COGS and inventory valuation. */
export const productEntity: EntityDef = {
  name: "product",
  label: "Product",
  pluralLabel: "Products",
  icon: "product",
  group: "inventory",
  titleField: "name",
  fields: [
    { name: "name", label: "Name", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 160 },
    { name: "sku", label: "SKU", type: "string", unique: true, searchable: true, sortable: true },
    { name: "unitPrice", label: "Unit Price", type: "currency", required: true, sortable: true, min: 0 },
    { name: "currencyCode", label: "Currency", type: "enum", filterable: true, defaultValue: "USD", options: CURRENCY_OPTIONS },
    { name: "taxRate", label: "Tax Rate", type: "percent", defaultValue: 0, min: 0, max: 100 },
    { name: "trackStock", label: "Track Stock", type: "boolean", filterable: true, defaultValue: false },
    { name: "costPrice", label: "Cost Price", type: "currency", defaultValue: 0, min: 0, sortable: true },
    { name: "reorderLevel", label: "Reorder Level", type: "number", defaultValue: 0, min: 0 },
    { name: "uom", label: "Unit", type: "string", defaultValue: "ea", max: 16 },
    { name: "active", label: "Active", type: "boolean", filterable: true, defaultValue: true },
  ],
  listColumns: [
    { field: "name", width: 220 },
    { field: "sku", width: 130 },
    { field: "unitPrice", width: 120 },
    { field: "costPrice", width: 120 },
    { field: "trackStock", width: 100 },
  ],
};
