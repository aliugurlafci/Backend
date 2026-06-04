import type { EntityDef } from "../types";
import { CURRENCY_OPTIONS } from "./shared";

/** Phase F6 — recurring billing plan (simple subscription). The billing run
 *  generates a draft invoice for each due plan and advances `nextRun`. */
export const recurringPlanEntity: EntityDef = {
  name: "recurringPlan",
  label: "Recurring Plan",
  pluralLabel: "Recurring",
  icon: "recurring",
  group: "finance",
  titleField: "name",
  ownable: true,
  fields: [
    { name: "name", label: "Name", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 160 },
    { name: "accountId", label: "Account", type: "reference", referenceEntity: "account", required: true, filterable: true },
    { name: "description", label: "Description", type: "string", required: true },
    { name: "amount", label: "Amount", type: "currency", required: true, min: 0, sortable: true },
    { name: "taxRate", label: "Tax %", type: "percent", defaultValue: 0, min: 0, max: 100 },
    { name: "currencyCode", label: "Currency", type: "enum", defaultValue: "USD", options: CURRENCY_OPTIONS },
    {
      name: "frequency",
      label: "Frequency",
      type: "enum",
      required: true,
      filterable: true,
      defaultValue: "monthly",
      options: [
        { value: "weekly", label: "Weekly" },
        { value: "monthly", label: "Monthly" },
        { value: "quarterly", label: "Quarterly" },
        { value: "yearly", label: "Yearly" },
      ],
    },
    { name: "nextRun", label: "Next Run", type: "date", required: true, sortable: true },
    { name: "active", label: "Active", type: "boolean", filterable: true, defaultValue: true },
  ],
  listColumns: [
    { field: "name", width: 220 },
    { field: "amount", width: 130 },
    { field: "frequency", width: 120 },
    { field: "nextRun", width: 130 },
  ],
};
