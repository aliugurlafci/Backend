import type { EntityDef } from "../types";

/** Phase F3 — currency lookup with conversion rate (base USD per 1 unit). */
export const currencyEntity: EntityDef = {
  name: "currency",
  label: "Currency",
  pluralLabel: "Currencies",
  icon: "wallet",
  group: "finance",
  titleField: "code",
  fields: [
    { name: "code", label: "Code", type: "string", required: true, unique: true, searchable: true, sortable: true, min: 3, max: 3 },
    { name: "symbol", label: "Symbol", type: "string", required: true, max: 4 },
    { name: "rate", label: "Rate (per USD)", type: "number", required: true, min: 0, defaultValue: 1, sortable: true },
  ],
  listColumns: [
    { field: "code", width: 100 },
    { field: "symbol", width: 100 },
    { field: "rate", width: 140 },
  ],
};
