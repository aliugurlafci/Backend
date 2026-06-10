import type { EntityDef } from "../types";
import { branchRef, currencyField, moneyTotals, notesField, numberField } from "./shared";

/**
 * Sales cart / basket — a persisted draft of an over-the-counter sale. "Checkout"
 * rings the basket through the invoice → send pipeline (reusing the POS service),
 * so the cart never duplicates GL/stock logic. Off the auto-nav; surfaced by the
 * bespoke `/cart` screen.
 */
export const cartEntity: EntityDef = {
  name: "cart",
  label: "Cart",
  pluralLabel: "Carts",
  icon: "cart",
  group: "sales",
  titleField: "number",
  system: true,
  ownable: true,
  fields: [
    numberField("Cart #"),
    { name: "accountId", label: "Customer", type: "reference", referenceEntity: "account", filterable: true },
    branchRef(),
    { name: "warehouseId", label: "Warehouse", type: "reference", referenceEntity: "warehouse", filterable: true },
    currencyField(),
    {
      name: "status",
      label: "Status",
      type: "enum",
      required: true,
      filterable: true,
      sortable: true,
      defaultValue: "open",
      options: [
        { value: "open", label: "Open", tone: "info" },
        { value: "converted", label: "Converted", tone: "success" },
      ],
    },
    { name: "convertedInvoiceId", label: "Invoice", type: "reference", referenceEntity: "invoice" },
    ...moneyTotals(),
    notesField(),
  ],
  listColumns: [
    { field: "number", width: 120 },
    { field: "accountId", width: 200 },
    { field: "status", width: 120 },
    { field: "total", width: 140 },
  ],
};
