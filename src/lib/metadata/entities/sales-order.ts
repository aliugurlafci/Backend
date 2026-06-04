import type { EntityDef } from "../types";

export const salesOrderEntity: EntityDef = {
  name: "salesOrder",
  label: "Sales Order",
  pluralLabel: "Sales Orders",
  icon: "order",
  group: "sales",
  titleField: "number",
  ownable: true,
  fields: [
    { name: "number", label: "Order #", type: "string", required: true, unique: true, searchable: true, sortable: true },
    { name: "accountId", label: "Account", type: "reference", referenceEntity: "account", filterable: true },
    {
      name: "status",
      label: "Status",
      type: "enum",
      required: true,
      filterable: true,
      sortable: true,
      defaultValue: "pending",
      options: [
        { value: "pending", label: "Pending", tone: "neutral" },
        { value: "confirmed", label: "Confirmed", tone: "info" },
        { value: "shipped", label: "Shipped", tone: "warning" },
        { value: "completed", label: "Completed", tone: "success" },
        { value: "cancelled", label: "Cancelled", tone: "danger" },
      ],
    },
    { name: "amount", label: "Amount", type: "currency", sortable: true, filterable: true, min: 0 },
    { name: "orderDate", label: "Order Date", type: "date", sortable: true },
  ],
  listColumns: [
    { field: "number", width: 160 },
    { field: "status", width: 140 },
    { field: "amount", width: 140 },
    { field: "orderDate", width: 140 },
  ],
};
