import type { EntityDef } from "../types";

/** A cashier till session (shift): opening float, accumulated sales, and the
 *  closing cash count + variance. POS sales (invoices) carry the sessionId.
 *  System entity — opened/closed from the POS terminal. */
export const posSessionEntity: EntityDef = {
  name: "posSession",
  label: "POS Session",
  pluralLabel: "POS Sessions",
  icon: "pos",
  group: "sales",
  titleField: "number",
  ownable: true,
  system: true,
  fields: [
    { name: "number", label: "Session #", type: "string", readOnly: true, searchable: true, sortable: true },
    { name: "branchId", label: "Branch", type: "reference", referenceEntity: "branch", filterable: true },
    { name: "warehouseId", label: "Warehouse", type: "reference", referenceEntity: "warehouse", filterable: true },
    { name: "cashierId", label: "Cashier", type: "reference", referenceEntity: "user", filterable: true },
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
        { value: "closed", label: "Closed", tone: "neutral" },
      ],
    },
    { name: "openingFloat", label: "Opening Float", type: "currency", defaultValue: 0, min: 0 },
    { name: "openedAt", label: "Opened At", type: "datetime", sortable: true },
    { name: "closedAt", label: "Closed At", type: "datetime", sortable: true },
    { name: "salesTotal", label: "Sales Total", type: "currency", computed: true, defaultValue: 0 },
    { name: "cashTotal", label: "Cash Sales", type: "currency", computed: true, defaultValue: 0 },
    { name: "expectedCash", label: "Expected Cash", type: "currency", computed: true, defaultValue: 0 },
    { name: "countedCash", label: "Counted Cash", type: "currency", defaultValue: 0, min: 0 },
    { name: "variance", label: "Variance", type: "currency", computed: true, defaultValue: 0 },
  ],
  listColumns: [
    { field: "number", width: 120 },
    { field: "branchId", width: 150 },
    { field: "cashierId", width: 150 },
    { field: "status", width: 100 },
    { field: "salesTotal", width: 120 },
  ],
  lifecycle: {
    field: "status",
    initial: "open",
    states: ["open", "closed"],
    finalStates: ["closed"],
    transitions: [{ from: "open", to: "closed", action: "close", requires: "posSession:update" }],
  },
};
