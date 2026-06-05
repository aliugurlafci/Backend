import type { EntityDef } from "../types";

/** Stock location. On-hand is derived from stockMovement rows per product+warehouse. */
export const warehouseEntity: EntityDef = {
  name: "warehouse",
  label: "Warehouse",
  pluralLabel: "Warehouses",
  icon: "warehouse",
  group: "inventory",
  titleField: "name",
  fields: [
    { name: "code", label: "Code", type: "string", required: true, unique: true, searchable: true, sortable: true, filterable: true, max: 40 },
    { name: "name", label: "Name", type: "string", required: true, searchable: true, sortable: true, max: 120 },
    { name: "branchId", label: "Branch", type: "reference", referenceEntity: "branch", filterable: true },
    { name: "address", label: "Address", type: "text" },
    { name: "active", label: "Active", type: "boolean", filterable: true, defaultValue: true },
  ],
  listColumns: [
    { field: "code", width: 120 },
    { field: "name", width: 240 },
    { field: "branchId", width: 180 },
    { field: "active", width: 100 },
  ],
};
