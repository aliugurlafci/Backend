import type { EntityDef } from "../types";

export const accountEntity: EntityDef = {
  name: "account",
  label: "Account",
  pluralLabel: "Accounts",
  icon: "building",
  titleField: "name",
  ownable: true,
  fields: [
    { name: "name", label: "Account Name", type: "string", required: true, unique: true, searchable: true, sortable: true, filterable: true, min: 1, max: 120 },
    { name: "email", label: "Email", type: "email", searchable: true },
    {
      name: "industry",
      label: "Industry",
      type: "enum",
      filterable: true,
      options: [
        { value: "technology", label: "Technology", tone: "info" },
        { value: "finance", label: "Finance", tone: "success" },
        { value: "healthcare", label: "Healthcare", tone: "warning" },
        { value: "retail", label: "Retail", tone: "neutral" },
        { value: "manufacturing", label: "Manufacturing", tone: "neutral" },
      ],
    },
    { name: "website", label: "Website", type: "url", searchable: true },
    { name: "phone", label: "Phone", type: "phone" },
    { name: "annualRevenue", label: "Annual Revenue", type: "currency", sortable: true, filterable: true, min: 0 },
    { name: "employees", label: "Employees", type: "number", sortable: true, min: 0 },
    { name: "branchId", label: "Branch", type: "reference", referenceEntity: "branch", filterable: true },
    { name: "dealerId", label: "Dealer", type: "reference", referenceEntity: "dealer", filterable: true },
  ],
  listColumns: [
    { field: "name", width: 260 },
    { field: "industry", width: 140 },
    { field: "annualRevenue", width: 160 },
    { field: "employees", width: 120 },
  ],
};
