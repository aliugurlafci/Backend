import type { EntityDef } from "../types";
import { CURRENCY_OPTIONS } from "./shared";

/** Phase F5 — Invoice header (AR). Totals computed from lines; amountPaid/balance
 *  computed from applied payments. `number` assigned by the finance service. */
export const invoiceEntity: EntityDef = {
  name: "invoice",
  label: "Invoice",
  pluralLabel: "Invoices",
  icon: "invoice",
  group: "sales",
  titleField: "number",
  ownable: true,
  fields: [
    { name: "number", label: "Number", type: "string", readOnly: true, searchable: true, sortable: true },
    { name: "accountId", label: "Account", type: "reference", referenceEntity: "account", required: true, filterable: true },
    { name: "quoteId", label: "Source Quote", type: "reference", referenceEntity: "quote" },
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
        { value: "partial", label: "Partial", tone: "warning" },
        { value: "paid", label: "Paid", tone: "success" },
        { value: "overdue", label: "Overdue", tone: "danger" },
        { value: "void", label: "Void", tone: "neutral" },
      ],
    },
    { name: "currencyCode", label: "Currency", type: "enum", defaultValue: "USD", options: CURRENCY_OPTIONS },
    { name: "issueDate", label: "Issue Date", type: "date", sortable: true },
    { name: "dueDate", label: "Due Date", type: "date", sortable: true },
    { name: "subtotal", label: "Subtotal", type: "currency", computed: true },
    { name: "taxTotal", label: "Tax", type: "currency", computed: true },
    { name: "total", label: "Total", type: "currency", computed: true, sortable: true },
    { name: "amountPaid", label: "Paid", type: "currency", computed: true },
    { name: "balance", label: "Balance", type: "currency", computed: true, sortable: true },
    { name: "notes", label: "Notes", type: "text" },
  ],
  listColumns: [
    { field: "number", width: 120 },
    { field: "accountId", width: 180 },
    { field: "status", width: 110 },
    { field: "total", width: 130 },
    { field: "balance", width: 130 },
  ],
  lifecycle: {
    field: "status",
    initial: "draft",
    states: ["draft", "sent", "partial", "paid", "overdue", "void"],
    finalStates: ["paid", "void"],
    transitions: [
      { from: "draft", to: "sent", action: "send", requires: "invoice:update" },
      { from: "draft", to: "void", action: "void", requires: "invoice:update" },
      { from: "sent", to: "void", action: "void", requires: "invoice:update" },
      { from: "overdue", to: "void", action: "void", requires: "invoice:update" },
    ],
  },
};
