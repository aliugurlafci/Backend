import type { EntityDef } from "../types";

/**
 * The Deal entity carries a lifecycle state machine (Phase 7) on its `stage`
 * field. Transitions are named actions guarded by permissions and invariants.
 */
export const dealEntity: EntityDef = {
  name: "deal",
  label: "Deal",
  pluralLabel: "Deals",
  icon: "target",
  group: "sales",
  titleField: "name",
  ownable: true,
  board: { groupByField: "stage" },
  fields: [
    { name: "name", label: "Deal Name", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 120 },
    {
      name: "stage",
      label: "Stage",
      type: "enum",
      required: true,
      filterable: true,
      sortable: true,
      defaultValue: "lead",
      options: [
        { value: "lead", label: "Lead", tone: "neutral" },
        { value: "qualified", label: "Qualified", tone: "info" },
        { value: "proposal", label: "Proposal", tone: "info" },
        { value: "negotiation", label: "Negotiation", tone: "warning" },
        { value: "won", label: "Won", tone: "success" },
        { value: "lost", label: "Lost", tone: "danger" },
      ],
    },
    { name: "amount", label: "Amount", type: "currency", sortable: true, filterable: true, min: 0 },
    { name: "probability", label: "Probability %", type: "number", min: 0, max: 100 },
    { name: "closeDate", label: "Close Date", type: "date", sortable: true },
    { name: "accountId", label: "Account", type: "reference", referenceEntity: "account", filterable: true },
    { name: "branchId", label: "Branch", type: "reference", referenceEntity: "branch", filterable: true },
    { name: "dealerId", label: "Dealer", type: "reference", referenceEntity: "dealer", filterable: true },
  ],
  listColumns: [
    { field: "name", width: 240 },
    { field: "stage", width: 140 },
    { field: "amount", width: 140 },
    { field: "closeDate", width: 140 },
  ],
  lifecycle: {
    field: "stage",
    initial: "lead",
    states: ["lead", "qualified", "proposal", "negotiation", "won", "lost"],
    finalStates: ["won", "lost"],
    transitions: [
      { from: "lead", to: "qualified", action: "qualify", requires: "deal:update" },
      { from: "qualified", to: "proposal", action: "propose", requires: "deal:update" },
      { from: "proposal", to: "negotiation", action: "negotiate", requires: "deal:update" },
      { from: "negotiation", to: "won", action: "win", requires: "deal:win", guards: ["amountPositive"] },
      { from: "lead", to: "lost", action: "lose", requires: "deal:update" },
      { from: "qualified", to: "lost", action: "lose", requires: "deal:update" },
      { from: "proposal", to: "lost", action: "lose", requires: "deal:update" },
      { from: "negotiation", to: "lost", action: "lose", requires: "deal:update" },
    ],
  },
};
