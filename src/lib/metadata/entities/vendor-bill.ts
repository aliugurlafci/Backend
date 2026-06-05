import type { EntityDef } from "../types";
import { branchRef, currencyField, moneyTotals, notesField, numberField, paidBalance } from "./shared";

/** Accounts-payable bill (mirror of invoice). Totals computed from lines;
 *  amountPaid/balance from applied bill payments. `receive` posts to the GL. */
export const vendorBillEntity: EntityDef = {
  name: "vendorBill",
  label: "Vendor Bill",
  pluralLabel: "Vendor Bills",
  icon: "receipt",
  group: "accounting",
  titleField: "number",
  ownable: true,
  fields: [
    numberField("Bill #"),
    { name: "supplierId", label: "Supplier", type: "reference", referenceEntity: "supplier", required: true, filterable: true },
    { name: "goodsReceiptId", label: "Goods Receipt", type: "reference", referenceEntity: "goodsReceipt", filterable: true },
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
        { value: "received", label: "Received", tone: "info" },
        { value: "partial", label: "Partial", tone: "warning" },
        { value: "paid", label: "Paid", tone: "success" },
        { value: "void", label: "Void", tone: "danger" },
      ],
    },
    currencyField(),
    { name: "billDate", label: "Bill Date", type: "date", sortable: true },
    { name: "dueDate", label: "Due Date", type: "date", sortable: true },
    branchRef(),
    ...moneyTotals(),
    ...paidBalance(),
    notesField(),
  ],
  listColumns: [
    { field: "number", width: 120 },
    { field: "supplierId", width: 200 },
    { field: "status", width: 110 },
    { field: "total", width: 130 },
    { field: "balance", width: 130 },
  ],
  lifecycle: {
    field: "status",
    initial: "draft",
    states: ["draft", "received", "partial", "paid", "void"],
    finalStates: ["paid", "void"],
    transitions: [
      { from: "draft", to: "received", action: "receive", requires: "vendorBill:receive" },
      { from: "draft", to: "void", action: "void", requires: "vendorBill:update" },
      { from: "received", to: "void", action: "void", requires: "vendorBill:receive" },
    ],
  },
};
