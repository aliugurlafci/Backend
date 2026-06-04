import type { EntityDef } from "../types";

/** File-manager entries (metadata only). Backs the bespoke `/file-manager` screen (system → off the auto-nav). */
export const fileEntity: EntityDef = {
  name: "file",
  label: "File",
  pluralLabel: "Files",
  icon: "file",
  group: "crm",
  titleField: "name",
  system: true,
  fields: [
    { name: "name", label: "Name", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 200 },
    {
      name: "folder",
      label: "Folder",
      type: "enum",
      filterable: true,
      defaultValue: "documents",
      options: [
        { value: "documents", label: "Documents" },
        { value: "contracts", label: "Contracts" },
        { value: "invoices", label: "Invoices" },
        { value: "media", label: "Media" },
        { value: "other", label: "Other" },
      ],
    },
    { name: "sizeKb", label: "Size (KB)", type: "number", defaultValue: 0, min: 0, sortable: true },
    { name: "owner", label: "Owner", type: "string", max: 120 },
  ],
  listColumns: [
    { field: "name", width: 280 },
    { field: "folder", width: 120 },
    { field: "sizeKb", width: 100 },
  ],
};
