import type { EntityDef } from "../types";
import { priceLineFields } from "./shared";

/** Vendor bill line item (child of vendorBill). */
export const vendorBillLineEntity: EntityDef = {
  name: "vendorBillLine",
  label: "Bill Line",
  pluralLabel: "Bill Lines",
  icon: "receipt",
  titleField: "description",
  system: true,
  parent: { entity: "vendorBill", field: "billId" },
  fields: priceLineFields({
    parentField: "billId",
    parentLabel: "Vendor Bill",
    parentEntity: "vendorBill",
    productFilterable: true,
    qtyLabel: "Quantity",
    taxLabel: "Tax Rate",
  }),
};
