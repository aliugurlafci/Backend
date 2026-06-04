import type { EntityDef } from "../types";

export const contractEntity: EntityDef = {
  name: "contract",
  label: "Contract",
  pluralLabel: "Contracts",
  icon: "contract",
  group: "sales",
  titleField: "title",
  ownable: true,
  fields: [
    { name: "title", label: "Contract Title", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 160 },
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
        { value: "active", label: "Active", tone: "success" },
        { value: "expired", label: "Expired", tone: "warning" },
        { value: "terminated", label: "Terminated", tone: "danger" },
      ],
    },
    { name: "value", label: "Contract Value", type: "currency", sortable: true, filterable: true, min: 0 },
    { name: "startDate", label: "Start Date", type: "date", sortable: true },
    { name: "endDate", label: "End Date", type: "date", sortable: true },
  ],
  listColumns: [
    { field: "title", width: 240 },
    { field: "status", width: 130 },
    { field: "value", width: 140 },
    { field: "endDate", width: 140 },
  ],
};
