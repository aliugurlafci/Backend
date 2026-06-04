import type { EntityDef } from "../types";

export const contactEntity: EntityDef = {
  name: "contact",
  label: "Contact",
  pluralLabel: "Contacts",
  icon: "user",
  titleField: "lastName",
  ownable: true,
  fields: [
    { name: "firstName", label: "First Name", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 60 },
    { name: "lastName", label: "Last Name", type: "string", required: true, searchable: true, sortable: true, filterable: true, min: 1, max: 60 },
    { name: "email", label: "Email", type: "email", required: true, unique: true, searchable: true, pii: true },
    { name: "phone", label: "Phone", type: "phone", pii: true },
    { name: "title", label: "Job Title", type: "string", searchable: true },
    { name: "accountId", label: "Account", type: "reference", referenceEntity: "account", filterable: true },
  ],
  listColumns: [
    { field: "lastName", width: 160 },
    { field: "firstName", width: 160 },
    { field: "email", width: 240 },
    { field: "title", width: 180 },
  ],
};
