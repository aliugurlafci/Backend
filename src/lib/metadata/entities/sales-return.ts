import type { EntityDef } from "../types";
import { branchRef, currencyField, moneyTotals, notesField, numberField } from "./shared";

/**
 * Sales return / credit document. Posting restocks the returned goods (a stock
 * receipt movement per line, refType `salesReturn`) and marks it posted. Surfaced
 * by the bespoke `/salesReturn` screen.
 */
export const salesReturnEntity: EntityDef = {
  name: "salesReturn",
  label: "Sales Return",
  pluralLabel: "Sales Returns",
  icon: "return",
  group: "sales",
  titleField: "number",
  system: true,
  ownable: true,
  fields: [
    numberField("Return #"),
    { name: "accountId", label: "Customer", type: "reference", referenceEntity: "account", filterable: true },
    { name: "invoiceId", label: "Original Invoice", type: "reference", referenceEntity: "invoice", filterable: true },
    { name: "warehouseId", label: "Warehouse", type: "reference", referenceEntity: "warehouse", filterable: true },
    branchRef(),
    currencyField(),
    { name: "returnDate", label: "Return Date", type: "date", sortable: true },
    { name: "reason", label: "Reason", type: "string", max: 200, searchable: true },
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
    ...moneyTotals(),
    notesField(),
  ],
  listColumns: [
    { field: "number", width: 130 },
    { field: "accountId", width: 200 },
    { field: "status", width: 120 },
    { field: "total", width: 140 },
    { field: "returnDate", width: 130 },
  ],
};
