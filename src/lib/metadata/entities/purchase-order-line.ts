import type { EntityDef } from "../types";
import { priceLineFields } from "./shared";

/** Purchase order line item (child of purchaseOrder). */
export const purchaseOrderLineEntity: EntityDef = {
  name: "purchaseOrderLine",
  label: "PO Line",
  pluralLabel: "PO Lines",
  icon: "order",
  titleField: "description",
  system: true,
  parent: { entity: "purchaseOrder", field: "poId" },
  fields: priceLineFields({
    parentField: "poId",
    parentLabel: "Purchase Order",
    parentEntity: "purchaseOrder",
    productFilterable: true,
    qtyLabel: "Quantity",
    taxLabel: "Tax Rate",
    withQtyReceived: true,
  }),
};
