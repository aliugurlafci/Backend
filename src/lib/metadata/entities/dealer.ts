import type { EntityDef } from "../types";

/** Dealer / reseller belonging to a branch. AR exposure tracked in `balance`. */
export const dealerEntity: EntityDef = {
  name: "dealer",
  label: "Dealer",
  pluralLabel: "Dealers",
  icon: "dealer",
  group: "branches",
  titleField: "name",
  ownable: true,
  fields: [
    { name: "code", label: "Code", type: "string", required: true, unique: true, searchable: true, sortable: true, filterable: true, max: 40 },
    { name: "name", label: "Name", type: "string", required: true, searchable: true, sortable: true, max: 120 },
    { name: "branchId", label: "Branch", type: "reference", referenceEntity: "branch", filterable: true },
    { name: "contactId", label: "Contact", type: "reference", referenceEntity: "contact" },
    { name: "email", label: "Email", type: "email", pii: true, searchable: true },
    { name: "phone", label: "Phone", type: "phone", pii: true },
    { name: "creditLimit", label: "Credit Limit", type: "currency", min: 0, defaultValue: 0 },
    { name: "balance", label: "Balance", type: "currency", computed: true },
    { name: "active", label: "Active", type: "boolean", filterable: true, defaultValue: true },
  ],
  listColumns: [
    { field: "code", width: 120 },
    { field: "name", width: 240 },
    { field: "branchId", width: 180 },
    { field: "creditLimit", width: 140 },
    { field: "balance", width: 140 },
  ],
};
