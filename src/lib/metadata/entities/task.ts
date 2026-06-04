import type { EntityDef } from "../types";

export const taskEntity: EntityDef = {
  name: "task",
  label: "Task",
  pluralLabel: "Tasks",
  icon: "check",
  titleField: "subject",
  ownable: true,
  fields: [
    { name: "subject", label: "Subject", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 160 },
    {
      name: "status",
      label: "Status",
      type: "enum",
      required: true,
      filterable: true,
      defaultValue: "open",
      options: [
        { value: "open", label: "Open", tone: "info" },
        { value: "done", label: "Done", tone: "success" },
      ],
    },
    { name: "dueDate", label: "Due Date", type: "date", sortable: true },
    { name: "notes", label: "Notes", type: "text" },
    { name: "dealId", label: "Related Deal", type: "reference", referenceEntity: "deal", filterable: true },
  ],
  listColumns: [
    { field: "subject", width: 280 },
    { field: "status", width: 120 },
    { field: "dueDate", width: 140 },
  ],
};
