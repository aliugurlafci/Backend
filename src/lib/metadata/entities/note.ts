import type { EntityDef } from "../types";

/** Free-form notes. Backs the bespoke `/notes` screen (system → off the auto-nav). */
export const noteEntity: EntityDef = {
  name: "note",
  label: "Note",
  pluralLabel: "Notes",
  icon: "note",
  group: "crm",
  titleField: "title",
  system: true,
  fields: [
    { name: "title", label: "Title", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 200 },
    { name: "body", label: "Body", type: "text", searchable: true },
  ],
  listColumns: [{ field: "title", width: 320 }],
};
