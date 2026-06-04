import type { EntityDef } from "../types";

/** Personal/team to-do items. Backs the bespoke `/todo` screen (system → off the auto-nav). */
export const todoEntity: EntityDef = {
  name: "todo",
  label: "To-Do",
  pluralLabel: "To Do",
  icon: "todo",
  group: "crm",
  titleField: "title",
  system: true,
  fields: [
    { name: "title", label: "Task", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 200 },
    {
      name: "priority",
      label: "Priority",
      type: "enum",
      filterable: true,
      defaultValue: "medium",
      options: [
        { value: "high", label: "High", tone: "danger" },
        { value: "medium", label: "Medium", tone: "warning" },
        { value: "low", label: "Low", tone: "info" },
      ],
    },
    { name: "dueDate", label: "Due Date", type: "date", sortable: true },
    { name: "done", label: "Done", type: "boolean", filterable: true, defaultValue: false },
  ],
  listColumns: [
    { field: "title", width: 320 },
    { field: "priority", width: 120 },
    { field: "dueDate", width: 140 },
    { field: "done", width: 80 },
  ],
};
