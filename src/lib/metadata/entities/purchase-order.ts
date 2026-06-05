import type { EntityDef } from "../types";
import { branchRef, currencyField, moneyTotals, notesField, numberField } from "./shared";

/** Purchase order header. Totals computed from lines; received status driven by GRN posting. */
export const purchaseOrderEntity: EntityDef = {
  name: "purchaseOrder",
  label: "Purchase Order",
  pluralLabel: "Purchase Orders",
  icon: "order",
  group: "purchasing",
  titleField: "number",
  ownable: true,
  fields: [
    numberField("PO #"),
    { name: "supplierId", label: "Supplier", type: "reference", referenceEntity: "supplier", required: true, filterable: true },
    { name: "warehouseId", label: "Warehouse", type: "reference", referenceEntity: "warehouse", required: true, filterable: true },
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
        { value: "sent", label: "Sent", tone: "info" },
        { value: "partial", label: "Partially Received", tone: "warning" },
        { value: "received", label: "Received", tone: "success" },
        { value: "cancelled", label: "Cancelled", tone: "danger" },
      ],
    },
    currencyField(),
    { name: "orderDate", label: "Order Date", type: "date", sortable: true },
    { name: "expectedDate", label: "Expected Date", type: "date", sortable: true },
    branchRef(),
    ...moneyTotals(),
    notesField(),
  ],
  listColumns: [
    { field: "number", width: 130 },
    { field: "supplierId", width: 200 },
    { field: "status", width: 150 },
    { field: "total", width: 130 },
    { field: "orderDate", width: 130 },
  ],
  lifecycle: {
    field: "status",
    initial: "draft",
    states: ["draft", "sent", "partial", "received", "cancelled"],
    finalStates: ["received", "cancelled"],
    transitions: [
      { from: "draft", to: "sent", action: "send", requires: "purchaseOrder:update" },
      { from: "draft", to: "cancelled", action: "cancel", requires: "purchaseOrder:update" },
      { from: "sent", to: "cancelled", action: "cancel", requires: "purchaseOrder:update" },
    ],
  },
};
