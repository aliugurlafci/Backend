import type { EntityDef } from "../types";

/**
 * Phase F1 — Lead: top-of-funnel prospect. Qualifying a lead can convert it into
 * an Account + Contact + Deal (domain `convertLead`).
 */
export const leadEntity: EntityDef = {
  name: "lead",
  label: "Lead",
  pluralLabel: "Leads",
  icon: "lead",
  group: "crm",
  titleField: "name",
  ownable: true,
  fields: [
    { name: "name", label: "Name", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 120 },
    { name: "company", label: "Company", type: "string", searchable: true, sortable: true, filterable: true },
    { name: "email", label: "Email", type: "email", searchable: true, pii: true },
    { name: "phone", label: "Phone", type: "phone", pii: true },
    {
      name: "source",
      label: "Source",
      type: "enum",
      filterable: true,
      options: [
        { value: "web", label: "Web", tone: "info" },
        { value: "referral", label: "Referral", tone: "success" },
        { value: "event", label: "Event", tone: "warning" },
        { value: "coldcall", label: "Cold Call", tone: "neutral" },
        { value: "other", label: "Other", tone: "neutral" },
      ],
    },
    { name: "estimatedValue", label: "Est. Value", type: "currency", sortable: true, min: 0 },
    {
      name: "status",
      label: "Status",
      type: "enum",
      required: true,
      filterable: true,
      sortable: true,
      defaultValue: "new",
      options: [
        { value: "new", label: "New", tone: "neutral" },
        { value: "working", label: "Working", tone: "info" },
        { value: "qualified", label: "Qualified", tone: "success" },
        { value: "unqualified", label: "Unqualified", tone: "danger" },
        { value: "converted", label: "Converted", tone: "success" },
      ],
    },
  ],
  listColumns: [
    { field: "name", width: 200 },
    { field: "company", width: 180 },
    { field: "source", width: 120 },
    { field: "status", width: 130 },
  ],
  lifecycle: {
    field: "status",
    initial: "new",
    states: ["new", "working", "qualified", "unqualified", "converted"],
    finalStates: ["unqualified", "converted"],
    transitions: [
      { from: "new", to: "working", action: "start", requires: "lead:update" },
      { from: "working", to: "qualified", action: "qualify", requires: "lead:update" },
      { from: "new", to: "unqualified", action: "disqualify", requires: "lead:update" },
      { from: "working", to: "unqualified", action: "disqualify", requires: "lead:update" },
    ],
  },
};
