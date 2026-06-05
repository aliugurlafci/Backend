import type { EntityDef } from "../types";

/** Company branch / location. Sales, stock, finance and accounting records carry a
 *  `branchId` reference so the business can report consolidated or by branch. */
export const branchEntity: EntityDef = {
  name: "branch",
  label: "Branch",
  pluralLabel: "Branches",
  icon: "branch",
  group: "branches",
  titleField: "name",
  fields: [
    { name: "code", label: "Code", type: "string", required: true, unique: true, searchable: true, sortable: true, filterable: true, max: 40 },
    { name: "name", label: "Name", type: "string", required: true, searchable: true, sortable: true, max: 120 },
    {
      name: "type",
      label: "Type",
      type: "enum",
      filterable: true,
      defaultValue: "branch",
      options: [
        { value: "headquarters", label: "Headquarters", tone: "info" },
        { value: "branch", label: "Branch", tone: "neutral" },
        { value: "franchise", label: "Franchise", tone: "success" },
      ],
    },
    { name: "managerId", label: "Manager", type: "reference", referenceEntity: "user" },
    { name: "phone", label: "Phone", type: "phone" },
    { name: "address", label: "Address", type: "text" },
    { name: "active", label: "Active", type: "boolean", filterable: true, defaultValue: true },
  ],
  listColumns: [
    { field: "code", width: 120 },
    { field: "name", width: 240 },
    { field: "type", width: 140 },
    { field: "active", width: 100 },
  ],
};
