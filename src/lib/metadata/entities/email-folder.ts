import type { EntityDef } from "../types";

/**
 * User-created mail folders. A message lives in a custom folder when its
 * `email.folderId` points here (otherwise it sits in its base system folder).
 * System entity → off the auto-nav; managed from the bespoke `/email` screen.
 */
export const emailFolderEntity: EntityDef = {
  name: "emailFolder",
  label: "Mail Folder",
  pluralLabel: "Mail Folders",
  icon: "label",
  group: "crm",
  titleField: "name",
  system: true,
  fields: [
    { name: "name", label: "Name", type: "string", required: true, searchable: true, sortable: true, max: 80 },
    // Optional hex accent shown as a dot in the folder rail.
    { name: "color", label: "Color", type: "string", max: 16 },
  ],
  listColumns: [{ field: "name", width: 220 }],
};
