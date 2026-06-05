import type { EntityDef } from "../types";

/** Journal line (child of journalEntry). Exactly one of debit/credit is non-zero.
 *  `posted` is denormalized from the header so the trial balance can aggregate
 *  only posted lines with a single-dimension groupBy. */
export const journalLineEntity: EntityDef = {
  name: "journalLine",
  label: "Journal Line",
  pluralLabel: "Journal Lines",
  icon: "ledger",
  titleField: "description",
  system: true,
  parent: { entity: "journalEntry", field: "entryId" },
  fields: [
    { name: "entryId", label: "Journal Entry", type: "reference", referenceEntity: "journalEntry", required: true, filterable: true },
    { name: "ledgerAccountId", label: "Account", type: "reference", referenceEntity: "ledgerAccount", required: true, filterable: true },
    { name: "debit", label: "Debit", type: "currency", defaultValue: 0, min: 0 },
    { name: "credit", label: "Credit", type: "currency", defaultValue: 0, min: 0 },
    { name: "description", label: "Description", type: "string" },
    { name: "branchId", label: "Branch", type: "reference", referenceEntity: "branch", filterable: true },
    { name: "posted", label: "Posted", type: "boolean", filterable: true, defaultValue: false },
  ],
};
