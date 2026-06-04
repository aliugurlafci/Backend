import type { EntityDef } from "../types";

export const proposalEntity: EntityDef = {
  name: "proposal",
  label: "Proposal",
  pluralLabel: "Proposals",
  icon: "proposal",
  group: "sales",
  titleField: "title",
  ownable: true,
  fields: [
    { name: "title", label: "Proposal Title", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 160 },
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
        { value: "accepted", label: "Accepted", tone: "success" },
        { value: "declined", label: "Declined", tone: "danger" },
      ],
    },
    { name: "amount", label: "Amount", type: "currency", sortable: true, filterable: true, min: 0 },
    { name: "validUntil", label: "Valid Until", type: "date", sortable: true },
  ],
  listColumns: [
    { field: "title", width: 260 },
    { field: "status", width: 130 },
    { field: "amount", width: 140 },
    { field: "validUntil", width: 140 },
  ],
};
