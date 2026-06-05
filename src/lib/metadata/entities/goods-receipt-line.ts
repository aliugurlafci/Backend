import type { EntityDef } from "../types";

/** Goods receipt line item (child of goodsReceipt). */
export const goodsReceiptLineEntity: EntityDef = {
  name: "goodsReceiptLine",
  label: "GRN Line",
  pluralLabel: "GRN Lines",
  icon: "stock",
  titleField: "productId",
  system: true,
  parent: { entity: "goodsReceipt", field: "grnId" },
  fields: [
    { name: "grnId", label: "Goods Receipt", type: "reference", referenceEntity: "goodsReceipt", required: true, filterable: true },
    { name: "productId", label: "Product", type: "reference", referenceEntity: "product", required: true, filterable: true },
    { name: "qty", label: "Quantity", type: "number", required: true, min: 0 },
    { name: "unitCost", label: "Unit Cost", type: "currency", defaultValue: 0, min: 0 },
    { name: "warehouseId", label: "Warehouse", type: "reference", referenceEntity: "warehouse", filterable: true },
  ],
};
