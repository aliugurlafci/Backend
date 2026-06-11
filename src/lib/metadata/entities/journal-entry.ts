import type { EntityDef } from "../types";

/** Double-entry journal header. Must balance (debit == credit) before posting.
 *  Auto-posted from sub-ledgers (invoice/payment/bill/GRN) via `source`+`sourceRef`. */
export const journalEntryEntity: EntityDef = {
  name: "journalEntry",
  label: "Journal Entry",
  pluralLabel: "Journal Entries",
  icon: "journal",
  group: "accounting",
  titleField: "number",
  fields: [
    { name: "number", label: "Entry #", type: "string", readOnly: true, searchable: true, sortable: true },
    { name: "date", label: "Date", type: "date", required: true, sortable: true },
    { name: "memo", label: "Memo", type: "text", searchable: true },
    {
      name: "source",
      label: "Source",
      type: "enum",
      filterable: true,
      defaultValue: "manual",
      options: [
        { value: "manual", label: "Manual", tone: "neutral" },
        { value: "invoice", label: "Invoice", tone: "info" },
        { value: "payment", label: "Payment", tone: "info" },
        { value: "vendorBill", label: "Vendor Bill", tone: "info" },
        { value: "billPayment", label: "Bill Payment", tone: "info" },
        { value: "goodsReceipt", label: "Goods Receipt", tone: "info" },
        { value: "stockIssue", label: "Stock Issue", tone: "info" },
        { value: "stockIssueVoid", label: "Stock Issue Void", tone: "warning" },
        { value: "invoiceVoid", label: "Invoice Void", tone: "warning" },
        { value: "stockTransfer", label: "Stock Transfer", tone: "info" },
        { value: "adjustment", label: "Adjustment", tone: "neutral" },
        { value: "reversal", label: "Reversal", tone: "warning" },
      ],
    },
    { name: "sourceRef", label: "Source Ref", type: "string", filterable: true, searchable: true },
    { name: "branchId", label: "Branch", type: "reference", referenceEntity: "branch", filterable: true },
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
    { name: "debitTotal", label: "Debit Total", type: "currency", computed: true, sortable: true },
    { name: "creditTotal", label: "Credit Total", type: "currency", computed: true },
  ],
  listColumns: [
    { field: "number", width: 120 },
    { field: "date", width: 120 },
    { field: "source", width: 120 },
    { field: "status", width: 110 },
    { field: "debitTotal", width: 130 },
  ],
  lifecycle: {
    field: "status",
    initial: "draft",
    states: ["draft", "posted", "void"],
    finalStates: ["void"],
    transitions: [
      { from: "draft", to: "posted", action: "post", requires: "journalEntry:post" },
      { from: "draft", to: "void", action: "void", requires: "journalEntry:update" },
      { from: "posted", to: "void", action: "void", requires: "journalEntry:post" },
    ],
  },
};
