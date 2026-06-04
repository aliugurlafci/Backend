import type { EntityDef } from "../types";

export const estimationEntity: EntityDef = {
  name: "estimation",
  label: "Estimation",
  pluralLabel: "Estimations",
  icon: "estimation",
  group: "sales",
  titleField: "number",
  ownable: true,
  fields: [
    { name: "number", label: "Estimate #", type: "string", required: true, unique: true, searchable: true, sortable: true },
    { name: "accountId", label: "Account", type: "reference", referenceEntity: "account", filterable: true },
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
        { value: "sent", label: "Sent", tone: "info" },
        { value: "approved", label: "Approved", tone: "success" },
        { value: "rejected", label: "Rejected", tone: "danger" },
      ],
    },
    { name: "amount", label: "Amount", type: "currency", sortable: true, filterable: true, min: 0 },
    { name: "expiryDate", label: "Expiry Date", type: "date", sortable: true },
  ],
  listColumns: [
    { field: "number", width: 160 },
    { field: "status", width: 130 },
    { field: "amount", width: 140 },
    { field: "expiryDate", width: 140 },
  ],
};
