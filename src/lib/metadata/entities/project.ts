import type { EntityDef } from "../types";

export const projectEntity: EntityDef = {
  name: "project",
  label: "Project",
  pluralLabel: "Projects",
  icon: "project",
  group: "projects",
  titleField: "name",
  ownable: true,
  fields: [
    { name: "name", label: "Project Name", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 160 },
    { name: "accountId", label: "Client", type: "reference", referenceEntity: "account", filterable: true },
    {
      name: "status",
      label: "Status",
      type: "enum",
      required: true,
      filterable: true,
      sortable: true,
      defaultValue: "planning",
      options: [
        { value: "planning", label: "Planning", tone: "neutral" },
        { value: "active", label: "Active", tone: "info" },
        { value: "on_hold", label: "On Hold", tone: "warning" },
        { value: "completed", label: "Completed", tone: "success" },
      ],
    },
    { name: "priority", label: "Priority", type: "enum", filterable: true, defaultValue: "medium", options: [
      { value: "low", label: "Low", tone: "neutral" },
      { value: "medium", label: "Medium", tone: "info" },
      { value: "high", label: "High", tone: "warning" },
    ] },
    { name: "budget", label: "Budget", type: "currency", sortable: true, filterable: true, min: 0 },
    { name: "progress", label: "Progress %", type: "percent", sortable: true, min: 0, max: 100 },
    { name: "startDate", label: "Start Date", type: "date", sortable: true },
    { name: "dueDate", label: "Due Date", type: "date", sortable: true },
  ],
  listColumns: [
    { field: "name", width: 240 },
    { field: "status", width: 130 },
    { field: "progress", width: 120 },
    { field: "dueDate", width: 140 },
  ],
};
