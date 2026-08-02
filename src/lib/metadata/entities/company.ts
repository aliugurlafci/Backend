import type { EntityDef } from "../types";

/**
 * Company — the legal entity a user belongs to.
 *
 * A deployment serves one tenant, but the people in it can belong to different
 * companies (the operator, its dealers, its subcontractors…). Every user carries
 * a `companyId`, which is what the Settings → Account card shows and what
 * company-scoped screens filter on.
 */
export const companyEntity: EntityDef = {
  name: "company",
  label: "Company",
  pluralLabel: "Companies",
  icon: "branch",
  group: "admin",
  titleField: "name",
  fields: [
    { name: "name", label: "Name", type: "string", required: true, unique: true, searchable: true, sortable: true, max: 160 },
    { name: "code", label: "Code", type: "string", searchable: true, sortable: true, filterable: true, max: 40 },
    { name: "taxNumber", label: "Tax Number", type: "string", searchable: true, max: 40 },
    { name: "taxOffice", label: "Tax Office", type: "string", max: 120 },
    { name: "phone", label: "Phone", type: "phone" },
    { name: "email", label: "Email", type: "email" },
    { name: "address", label: "Address", type: "text" },
    { name: "active", label: "Active", type: "boolean", filterable: true, defaultValue: true },
  ],
  listColumns: [
    { field: "name", width: 240 },
    { field: "code", width: 120 },
    { field: "taxNumber", width: 160 },
    { field: "active", width: 100 },
  ],
};
