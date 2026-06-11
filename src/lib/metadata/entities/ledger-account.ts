import type { EntityDef } from "../types";

/** Chart-of-accounts entry. `subtype` lets the posting engine resolve the right
 *  account (e.g. accounts_receivable) without hard-coding ids. */
export const ledgerAccountEntity: EntityDef = {
  name: "ledgerAccount",
  label: "Ledger Account",
  pluralLabel: "Chart of Accounts",
  icon: "ledger",
  group: "accounting",
  titleField: "name",
  fields: [
    { name: "code", label: "Code", type: "string", required: true, unique: true, searchable: true, sortable: true, filterable: true, max: 20 },
    { name: "name", label: "Name", type: "string", required: true, searchable: true, sortable: true, max: 120 },
    {
      name: "type",
      label: "Type",
      type: "enum",
      required: true,
      filterable: true,
      sortable: true,
      options: [
        { value: "asset", label: "Asset", tone: "info" },
        { value: "liability", label: "Liability", tone: "warning" },
        { value: "equity", label: "Equity", tone: "neutral" },
        { value: "revenue", label: "Revenue", tone: "success" },
        { value: "expense", label: "Expense", tone: "danger" },
      ],
    },
    {
      name: "subtype",
      label: "Subtype",
      type: "enum",
      filterable: true,
      options: [
        { value: "cash", label: "Cash / Bank" },
        { value: "accounts_receivable", label: "Accounts Receivable" },
        { value: "inventory", label: "Inventory" },
        { value: "gr_ir", label: "GR/IR Clearing" },
        { value: "fixed_asset", label: "Fixed Asset" },
        { value: "accounts_payable", label: "Accounts Payable" },
        { value: "tax_payable", label: "Tax Payable" },
        { value: "retained_earnings", label: "Retained Earnings" },
        { value: "sales_revenue", label: "Sales Revenue" },
        { value: "cogs", label: "Cost of Goods Sold" },
        { value: "purchase_price_variance", label: "Purchase Price Variance" },
        { value: "operating_expense", label: "Operating Expense" },
        { value: "other", label: "Other" },
      ],
    },
    { name: "parentId", label: "Parent Account", type: "reference", referenceEntity: "ledgerAccount" },
    {
      name: "normalBalance",
      label: "Normal Balance",
      type: "enum",
      required: true,
      defaultValue: "debit",
      options: [
        { value: "debit", label: "Debit" },
        { value: "credit", label: "Credit" },
      ],
    },
    { name: "isPostable", label: "Postable", type: "boolean", filterable: true, defaultValue: true },
    { name: "active", label: "Active", type: "boolean", filterable: true, defaultValue: true },
  ],
  listColumns: [
    { field: "code", width: 100 },
    { field: "name", width: 240 },
    { field: "type", width: 120 },
    { field: "subtype", width: 180 },
  ],
};
