import type { EntityDef } from "../types";

export const departmentEntity: EntityDef = {
  name: "department",
  label: "Department",
  pluralLabel: "Departments",
  icon: "department",
  group: "people",
  titleField: "name",
  fields: [
    { name: "name", label: "Department", type: "string", required: true, unique: true, searchable: true, sortable: true, min: 1, max: 120 },
    { name: "head", label: "Department Head", type: "string", searchable: true },
    { name: "headcount", label: "Headcount", type: "number", sortable: true, min: 0 },
  ],
  listColumns: [
    { field: "name", width: 280 },
    { field: "head", width: 220 },
    { field: "headcount", width: 120 },
  ],
};
