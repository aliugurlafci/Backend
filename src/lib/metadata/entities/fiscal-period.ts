import type { EntityDef } from "../types";

/** Accounting period. Posting into a closed period is rejected by the service. */
export const fiscalPeriodEntity: EntityDef = {
  name: "fiscalPeriod",
  label: "Fiscal Period",
  pluralLabel: "Fiscal Periods",
  icon: "calendar",
  group: "accounting",
  titleField: "name",
  fields: [
    { name: "name", label: "Name", type: "string", required: true, unique: true, searchable: true, sortable: true, max: 40 },
    { name: "startDate", label: "Start Date", type: "date", required: true, sortable: true },
    { name: "endDate", label: "End Date", type: "date", required: true, sortable: true },
    {
      name: "status",
      label: "Status",
      type: "enum",
      required: true,
      filterable: true,
      defaultValue: "open",
      options: [
        { value: "open", label: "Open", tone: "success" },
        { value: "closed", label: "Closed", tone: "neutral" },
      ],
    },
  ],
  listColumns: [
    { field: "name", width: 140 },
    { field: "startDate", width: 140 },
    { field: "endDate", width: 140 },
    { field: "status", width: 120 },
  ],
  lifecycle: {
    field: "status",
    initial: "open",
    states: ["open", "closed"],
    finalStates: [],
    transitions: [
      { from: "open", to: "closed", action: "close", requires: "fiscalPeriod:close" },
      { from: "closed", to: "open", action: "reopen", requires: "fiscalPeriod:close" },
    ],
  },
};
