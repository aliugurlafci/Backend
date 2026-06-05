import type { EntityDef } from "../types";

/** Inter-warehouse stock transfer (single product). Posting writes paired
 *  transfer_out / transfer_in movements (inventory net-zero). */
export const stockTransferEntity: EntityDef = {
  name: "stockTransfer",
  label: "Stock Transfer",
  pluralLabel: "Stock Transfers",
  icon: "transfer",
  group: "inventory",
  titleField: "number",
  ownable: true,
  fields: [
    { name: "number", label: "Transfer #", type: "string", readOnly: true, searchable: true, sortable: true },
    { name: "fromWarehouseId", label: "From Warehouse", type: "reference", referenceEntity: "warehouse", required: true, filterable: true },
    { name: "toWarehouseId", label: "To Warehouse", type: "reference", referenceEntity: "warehouse", required: true, filterable: true },
    { name: "productId", label: "Product", type: "reference", referenceEntity: "product", required: true, filterable: true },
    { name: "qty", label: "Quantity", type: "number", required: true, min: 0 },
    { name: "unitCost", label: "Unit Cost", type: "currency", defaultValue: 0, min: 0 },
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
    { name: "transferDate", label: "Transfer Date", type: "date", sortable: true },
    { name: "branchId", label: "Branch", type: "reference", referenceEntity: "branch", filterable: true },
  ],
  listColumns: [
    { field: "number", width: 120 },
    { field: "productId", width: 200 },
    { field: "qty", width: 100 },
    { field: "status", width: 110 },
    { field: "transferDate", width: 130 },
  ],
  lifecycle: {
    field: "status",
    initial: "draft",
    states: ["draft", "posted", "void"],
    finalStates: ["void"],
    transitions: [
      { from: "draft", to: "posted", action: "post", requires: "stockTransfer:post" },
      { from: "posted", to: "void", action: "void", requires: "stockTransfer:post" },
    ],
  },
};
