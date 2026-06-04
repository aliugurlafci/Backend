import type { EntityDef } from "../types";

export const timesheetEntity: EntityDef = {
  name: "timesheet",
  label: "Timesheet",
  pluralLabel: "Timesheets",
  icon: "timesheet",
  group: "projects",
  titleField: "title",
  ownable: true,
  fields: [
    { name: "title", label: "Description", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 200 },
    { name: "projectId", label: "Project", type: "reference", referenceEntity: "project", filterable: true },
    { name: "hours", label: "Hours", type: "number", required: true, sortable: true, min: 0, max: 24 },
    { name: "date", label: "Date", type: "date", required: true, sortable: true },
    { name: "billable", label: "Billable", type: "boolean", filterable: true, defaultValue: true },
    {
      name: "status",
      label: "Status",
      type: "enum",
      filterable: true,
      defaultValue: "draft",
      options: [
        { value: "draft", label: "Draft", tone: "neutral" },
        { value: "submitted", label: "Submitted", tone: "info" },
        { value: "approved", label: "Approved", tone: "success" },
      ],
    },
  ],
  listColumns: [
    { field: "title", width: 240 },
    { field: "hours", width: 100 },
    { field: "date", width: 140 },
    { field: "status", width: 130 },
  ],
};
