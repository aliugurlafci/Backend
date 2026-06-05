import type { EntityDef } from "../types";

/** Phase F5 — Payment applied against an invoice (AR receipt). */
export const paymentEntity: EntityDef = {
  name: "payment",
  label: "Payment",
  pluralLabel: "Payments",
  icon: "payment",
  group: "finance",
  titleField: "number",
  ownable: true,
  fields: [
    { name: "number", label: "Number", type: "string", readOnly: true, searchable: true, sortable: true },
    { name: "invoiceId", label: "Invoice", type: "reference", referenceEntity: "invoice", required: true, filterable: true },
    { name: "accountId", label: "Account", type: "reference", referenceEntity: "account", filterable: true },
    { name: "branchId", label: "Branch", type: "reference", referenceEntity: "branch", filterable: true },
    { name: "dealerId", label: "Dealer", type: "reference", referenceEntity: "dealer", filterable: true },
    { name: "amount", label: "Amount", type: "currency", required: true, min: 0, sortable: true },
    {
      name: "method",
      label: "Method",
      type: "enum",
      required: true,
      filterable: true,
      defaultValue: "bank",
      options: [
        { value: "bank", label: "Bank Transfer", tone: "info" },
        { value: "card", label: "Card", tone: "info" },
        { value: "cash", label: "Cash", tone: "neutral" },
        { value: "other", label: "Other", tone: "neutral" },
      ],
    },
    { name: "paidAt", label: "Paid At", type: "date", required: true, sortable: true },
    { name: "notes", label: "Notes", type: "text" },
  ],
  listColumns: [
    { field: "number", width: 120 },
    { field: "amount", width: 130 },
    { field: "method", width: 130 },
    { field: "paidAt", width: 130 },
  ],
};
