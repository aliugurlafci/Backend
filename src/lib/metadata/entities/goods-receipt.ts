import type { EntityDef } from "../types";
import { branchRef, notesField, numberField } from "./shared";

/** Goods receipt (GRN) header. Posting writes stock movements + (Phase 5) a GL entry. */
export const goodsReceiptEntity: EntityDef = {
  name: "goodsReceipt",
  label: "Goods Receipt",
  pluralLabel: "Goods Receipts",
  icon: "stock",
  group: "purchasing",
  titleField: "number",
  ownable: true,
  fields: [
    numberField("GRN #"),
    { name: "poId", label: "Purchase Order", type: "reference", referenceEntity: "purchaseOrder", filterable: true },
    { name: "supplierId", label: "Supplier", type: "reference", referenceEntity: "supplier", filterable: true },
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
        { value: "posted", label: "Posted", tone: "success" },
        { value: "void", label: "Void", tone: "danger" },
      ],
    },
    { name: "receiptDate", label: "Receipt Date", type: "date", sortable: true },
    branchRef(),
    notesField(),
  ],
  listColumns: [
    { field: "number", width: 130 },
    { field: "supplierId", width: 200 },
    { field: "warehouseId", width: 180 },
    { field: "status", width: 120 },
    { field: "receiptDate", width: 130 },
  ],
  lifecycle: {
    field: "status",
    initial: "draft",
    states: ["draft", "posted", "void"],
    finalStates: ["void"],
    transitions: [
      { from: "draft", to: "posted", action: "post", requires: "goodsReceipt:post" },
      { from: "posted", to: "void", action: "void", requires: "goodsReceipt:post" },
    ],
  },
};
