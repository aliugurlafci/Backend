import type { EntityDef } from "../types";

/** Call-log entries. Backs the bespoke `/calls` screen (system → off the auto-nav). */
export const callEntity: EntityDef = {
  name: "call",
  label: "Call",
  pluralLabel: "Calls",
  icon: "call",
  group: "crm",
  titleField: "contact",
  system: true,
  fields: [
    { name: "contact", label: "Contact", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 160 },
    {
      name: "type",
      label: "Type",
      type: "enum",
      required: true,
      filterable: true,
      defaultValue: "outgoing",
      options: [
        { value: "incoming", label: "Incoming", tone: "success" },
        { value: "outgoing", label: "Outgoing", tone: "info" },
        { value: "missed", label: "Missed", tone: "danger" },
      ],
    },
    { name: "durationSec", label: "Duration (sec)", type: "number", defaultValue: 0, min: 0, sortable: true },
    { name: "notes", label: "Notes", type: "text" },
  ],
  listColumns: [
    { field: "contact", width: 220 },
    { field: "type", width: 120 },
    { field: "durationSec", width: 120 },
  ],
};
