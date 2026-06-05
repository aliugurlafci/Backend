import type { EntityDef } from "../types";

/**
 * Immutable inventory ledger — the single source of truth for stock.
 * On-hand = SUM(qty) (signed: + receipt, − issue), valuation = SUM(value).
 * Written only by the inventory service; `stockKey` ("{productId}:{warehouseId}")
 * lets a single-dimension groupBy aggregate on-hand per product+warehouse.
 */
export const stockMovementEntity: EntityDef = {
  name: "stockMovement",
  label: "Stock Movement",
  pluralLabel: "Stock Movements",
  icon: "transfer",
  group: "inventory",
  titleField: "ref",
  system: true,
  fields: [
    { name: "productId", label: "Product", type: "reference", referenceEntity: "product", required: true, filterable: true },
    { name: "warehouseId", label: "Warehouse", type: "reference", referenceEntity: "warehouse", required: true, filterable: true },
    { name: "qty", label: "Quantity", type: "number", required: true },
    {
      name: "type",
      label: "Type",
      type: "enum",
      required: true,
      filterable: true,
      options: [
        { value: "receipt", label: "Receipt", tone: "success" },
        { value: "issue", label: "Issue", tone: "danger" },
        { value: "transfer_out", label: "Transfer Out", tone: "warning" },
        { value: "transfer_in", label: "Transfer In", tone: "info" },
        { value: "adjustment", label: "Adjustment", tone: "neutral" },
      ],
    },
    { name: "unitCost", label: "Unit Cost", type: "currency", defaultValue: 0, min: 0 },
    { name: "value", label: "Value", type: "currency", computed: true },
    { name: "ref", label: "Reference", type: "string", filterable: true, searchable: true },
    {
      name: "refType",
      label: "Source",
      type: "enum",
      filterable: true,
      options: [
        { value: "opening", label: "Opening Balance", tone: "neutral" },
        { value: "goodsReceipt", label: "Goods Receipt", tone: "info" },
        { value: "invoice", label: "Invoice", tone: "info" },
        { value: "salesOrder", label: "Sales Order", tone: "info" },
        { value: "stockTransfer", label: "Stock Transfer", tone: "info" },
        { value: "adjustment", label: "Adjustment", tone: "neutral" },
      ],
    },
    { name: "branchId", label: "Branch", type: "reference", referenceEntity: "branch", filterable: true },
    { name: "movedAt", label: "Moved At", type: "datetime", sortable: true },
    { name: "stockKey", label: "Stock Key", type: "string", filterable: true, computed: true },
  ],
};
