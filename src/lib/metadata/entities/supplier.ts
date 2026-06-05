import type { EntityDef } from "../types";
import { CURRENCY_OPTIONS } from "./shared";

/** Vendor / supplier — referenced by purchase orders, goods receipts and AP bills. */
export const supplierEntity: EntityDef = {
  name: "supplier",
  label: "Supplier",
  pluralLabel: "Suppliers",
  icon: "supplier",
  group: "purchasing",
  titleField: "name",
  ownable: true,
  fields: [
    { name: "name", label: "Name", type: "string", required: true, searchable: true, sortable: true, filterable: true, min: 1, max: 160 },
    { name: "code", label: "Code", type: "string", unique: true, searchable: true, filterable: true, max: 40 },
    { name: "email", label: "Email", type: "email", pii: true, searchable: true },
    { name: "phone", label: "Phone", type: "phone", pii: true },
    { name: "address", label: "Address", type: "text" },
    { name: "taxNumber", label: "Tax Number", type: "string", max: 40 },
    { name: "currencyCode", label: "Currency", type: "enum", filterable: true, defaultValue: "USD", options: CURRENCY_OPTIONS },
    { name: "active", label: "Active", type: "boolean", filterable: true, defaultValue: true },
  ],
  listColumns: [
    { field: "name", width: 240 },
    { field: "code", width: 120 },
    { field: "phone", width: 150 },
    { field: "active", width: 100 },
  ],
};
