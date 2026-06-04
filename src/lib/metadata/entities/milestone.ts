import type { EntityDef } from "../types";

export const milestoneEntity: EntityDef = {
  name: "milestone",
  label: "Milestone",
  pluralLabel: "Milestones",
  icon: "milestone",
  group: "projects",
  titleField: "name",
  ownable: true,
  fields: [
    { name: "name", label: "Milestone", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 160 },
    { name: "projectId", label: "Project", type: "reference", referenceEntity: "project", required: true, filterable: true },
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
        { value: "in_progress", label: "In Progress", tone: "info" },
        { value: "done", label: "Done", tone: "success" },
      ],
    },
    { name: "amount", label: "Value", type: "currency", min: 0 },
    { name: "dueDate", label: "Due Date", type: "date", sortable: true },
  ],
  listColumns: [
    { field: "name", width: 240 },
    { field: "projectId", width: 200 },
    { field: "status", width: 130 },
    { field: "dueDate", width: 140 },
  ],
};
