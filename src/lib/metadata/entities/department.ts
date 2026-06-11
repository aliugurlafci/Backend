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
    // Manager — pickable from employees OR users; stored as "employee:<id>" / "user:<id>".
    { name: "head", label: "Manager", type: "string", personPicker: true, filterable: true },
    // Derived (read-only): how many people report to the selected manager. Filled
    // live on read by the domain service — never entered by hand.
    { name: "headcount", label: "Headcount", type: "number", sortable: true, min: 0, readOnly: true },
  ],
  listColumns: [
    { field: "name", width: 280 },
    { field: "head", width: 220 },
    { field: "headcount", width: 120 },
  ],
};
