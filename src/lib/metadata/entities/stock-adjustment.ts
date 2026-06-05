import type { EntityDef } from "../types";

/** Stock adjustment / cycle count (single product). Posting writes an adjustment
 *  movement (signed qtyDelta) + a GL entry (Inventory vs Inventory Adjustments). */
export const stockAdjustmentEntity: EntityDef = {
  name: "stockAdjustment",
  label: "Stock Adjustment",
  pluralLabel: "Stock Adjustments",
  icon: "stock",
  group: "inventory",
  titleField: "number",
  ownable: true,
  fields: [
    { name: "number", label: "Adjustment #", type: "string", readOnly: true, searchable: true, sortable: true },
    { name: "warehouseId", label: "Warehouse", type: "reference", referenceEntity: "warehouse", required: true, filterable: true },
    { name: "productId", label: "Product", type: "reference", referenceEntity: "product", required: true, filterable: true },
    { name: "qtyDelta", label: "Quantity Delta", type: "number", required: true },
    { name: "unitCost", label: "Unit Cost", type: "currency", defaultValue: 0, min: 0 },
    { name: "reason", label: "Reason", type: "string", max: 160 },
    {
      name: "status",
      label: "Status",
      type: "enum",
      required: true,
      filterable: true,
      sortable: true,
      defaultValue: "draft",
      options: [
        { value: "draft", label: "Draft", tone: "neutral" },
        { value: "posted", label: "Posted", tone: "success" },
        { value: "void", label: "Void", tone: "danger" },
      ],
    },
    { name: "adjustedAt", label: "Date", type: "date", sortable: true },
    { name: "branchId", label: "Branch", type: "reference", referenceEntity: "branch", filterable: true },
  ],
  listColumns: [
    { field: "number", width: 120 },
    { field: "productId", width: 200 },
    { field: "qtyDelta", width: 110 },
    { field: "status", width: 110 },
    { field: "adjustedAt", width: 130 },
  ],
  lifecycle: {
    field: "status",
    initial: "draft",
    states: ["draft", "posted", "void"],
    finalStates: ["void"],
    transitions: [
      { from: "draft", to: "posted", action: "post", requires: "stockAdjustment:post" },
      { from: "posted", to: "void", action: "void", requires: "stockAdjustment:post" },
    ],
  },
};
