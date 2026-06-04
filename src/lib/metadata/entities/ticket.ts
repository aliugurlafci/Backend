import type { EntityDef } from "../types";

export const ticketEntity: EntityDef = {
  name: "ticket",
  label: "Ticket",
  pluralLabel: "Tickets",
  icon: "ticket",
  group: "support",
  titleField: "subject",
  ownable: true,
  board: { groupByField: "status" },
  fields: [
    { name: "subject", label: "Subject", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 200 },
    { name: "accountId", label: "Account", type: "reference", referenceEntity: "account", filterable: true },
    {
      name: "priority",
      label: "Priority",
      type: "enum",
      required: true,
      filterable: true,
      sortable: true,
      defaultValue: "medium",
      options: [
        { value: "low", label: "Low", tone: "neutral" },
        { value: "medium", label: "Medium", tone: "info" },
        { value: "high", label: "High", tone: "warning" },
        { value: "urgent", label: "Urgent", tone: "danger" },
      ],
    },
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
        { value: "pending", label: "Pending", tone: "warning" },
        { value: "resolved", label: "Resolved", tone: "success" },
        { value: "closed", label: "Closed", tone: "neutral" },
      ],
    },
    { name: "assignee", label: "Assignee", type: "string", filterable: true },
  ],
  listColumns: [
    { field: "subject", width: 280 },
    { field: "priority", width: 120 },
    { field: "status", width: 120 },
    { field: "assignee", width: 160 },
  ],
};
