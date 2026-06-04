import type { EntityDef } from "../types";

export const employeeEntity: EntityDef = {
  name: "employee",
  label: "Employee",
  pluralLabel: "Staff",
  icon: "employee",
  group: "people",
  titleField: "firstName",
  fields: [
    { name: "firstName", label: "First Name", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 80, pii: true },
    { name: "lastName", label: "Last Name", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 80, pii: true },
    { name: "email", label: "Email", type: "email", searchable: true, pii: true },
    { name: "phone", label: "Phone", type: "phone", pii: true },
    { name: "title", label: "Job Title", type: "string", searchable: true, sortable: true, suggest: true },
    { name: "departmentId", label: "Department", type: "reference", referenceEntity: "department", filterable: true },
    {
      name: "status",
      label: "Status",
      type: "enum",
      filterable: true,
      sortable: true,
      defaultValue: "active",
      options: [
        { value: "active", label: "Active", tone: "success" },
        { value: "on_leave", label: "On Leave", tone: "warning" },
        { value: "inactive", label: "Inactive", tone: "neutral" },
      ],
    },
  ],
  listColumns: [
    { field: "firstName", width: 160 },
    { field: "lastName", width: 160 },
    { field: "title", width: 200 },
    { field: "status", width: 120 },
  ],
};
