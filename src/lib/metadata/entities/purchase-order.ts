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
        { value: "pending", label: "Pending Approval", tone: "info" },
        { value: "approved", label: "Approved", tone: "info" },
        { value: "partial", label: "Partially Received", tone: "warning" },
        { value: "received", label: "Received", tone: "success" },
        { value: "rejected", label: "Rejected", tone: "danger" },
        { value: "cancelled", label: "Cancelled", tone: "danger" },
      ],
    },
    // Approval routing (set by submit/approve; computed → server-managed only).
    { name: "approverId", label: "Approver", type: "reference", referenceEntity: "user", computed: true, filterable: true },
    { name: "approvedAt", label: "Approved At", type: "datetime", computed: true },
    { name: "rejectionReason", label: "Rejection Reason", type: "string", computed: true, max: 240 },
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
  // Submit / approve / reject are bespoke (conditional supervisor routing +
  // record-level auth) and run through PurchasingService, not the state machine.
  // The generic transitions below only cover cancel + reopen.
  lifecycle: {
    field: "status",
    initial: "draft",
    states: ["draft", "pending", "approved", "partial", "received", "rejected", "cancelled"],
    finalStates: ["received", "cancelled"],
    transitions: [
      { from: "draft", to: "cancelled", action: "cancel", requires: "purchaseOrder:update" },
      { from: "pending", to: "cancelled", action: "cancel", requires: "purchaseOrder:update" },
      { from: "approved", to: "cancelled", action: "cancel", requires: "purchaseOrder:update" },
      { from: "rejected", to: "draft", action: "reopen", requires: "purchaseOrder:update" },
    ],
  },
};
