import type { EntityDef } from "../types";

/** Payment made against a vendor bill (AP disbursement). */
export const billPaymentEntity: EntityDef = {
  name: "billPayment",
  label: "Bill Payment",
  pluralLabel: "Bill Payments",
  icon: "payment",
  group: "accounting",
  titleField: "number",
  ownable: true,
  fields: [
    { name: "number", label: "Number", type: "string", readOnly: true, searchable: true, sortable: true },
    { name: "billId", label: "Vendor Bill", type: "reference", referenceEntity: "vendorBill", required: true, filterable: true },
    { name: "supplierId", label: "Supplier", type: "reference", referenceEntity: "supplier", filterable: true },
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
    { name: "branchId", label: "Branch", type: "reference", referenceEntity: "branch", filterable: true },
    { name: "notes", label: "Notes", type: "text" },
  ],
  listColumns: [
    { field: "number", width: 120 },
    { field: "supplierId", width: 200 },
    { field: "amount", width: 130 },
    { field: "paidAt", width: 130 },
  ],
};
