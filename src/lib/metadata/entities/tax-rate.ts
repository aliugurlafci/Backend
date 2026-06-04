import type { EntityDef } from "../types";

/** Phase F3 — reusable tax rates (VAT/GST). Lines copy the percentage at add time. */
export const taxRateEntity: EntityDef = {
  name: "taxRate",
  label: "Tax Rate",
  pluralLabel: "Tax Rates",
  icon: "receipt",
  group: "finance",
  titleField: "name",
  fields: [
    { name: "name", label: "Name", type: "string", required: true, searchable: true, sortable: true },
    { name: "rate", label: "Rate", type: "percent", required: true, min: 0, max: 100, sortable: true },
    { name: "region", label: "Region", type: "string", filterable: true },
  ],
  listColumns: [
    { field: "name", width: 200 },
    { field: "rate", width: 120 },
    { field: "region", width: 140 },
  ],
};
