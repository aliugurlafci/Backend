import type { EntityDef } from "../types";
import { CURRENCY_OPTIONS } from "./shared";

/** Phase F4 — Quote header. Totals are computed from quote lines. `number` is
 *  assigned by the finance service on create. */
export const quoteEntity: EntityDef = {
  name: "quote",
  label: "Quote",
  pluralLabel: "Quotes",
  icon: "quote",
  group: "sales",
  titleField: "number",
  ownable: true,
  fields: [
    { name: "number", label: "Number", type: "string", readOnly: true, searchable: true, sortable: true },
    { name: "accountId", label: "Account", type: "reference", referenceEntity: "account", required: true, filterable: true },
    {
      name: "status",
      label: "Status",
      type: "enum",
      required: true,
      filterable: true,
      sortable: true,
      defaultValue: "draft",
      options: [
        { value: "draft", label: "Draft", tone: "neutral" },
        { value: "sent", label: "Sent", tone: "info" },
        { value: "accepted", label: "Accepted", tone: "success" },
        { value: "declined", label: "Declined", tone: "danger" },
        { value: "expired", label: "Expired", tone: "warning" },
      ],
    },
    { name: "currencyCode", label: "Currency", type: "enum", defaultValue: "USD", options: CURRENCY_OPTIONS },
    { name: "validUntil", label: "Valid Until", type: "date", sortable: true },
    { name: "subtotal", label: "Subtotal", type: "currency", computed: true },
    { name: "taxTotal", label: "Tax", type: "currency", computed: true },
    { name: "total", label: "Total", type: "currency", computed: true, sortable: true },
    { name: "notes", label: "Notes", type: "text" },
  ],
  listColumns: [
    { field: "number", width: 120 },
    { field: "accountId", width: 200 },
    { field: "status", width: 120 },
    { field: "total", width: 140 },
  ],
  lifecycle: {
    field: "status",
    initial: "draft",
    states: ["draft", "sent", "accepted", "declined", "expired"],
    finalStates: ["accepted", "declined", "expired"],
    transitions: [
      { from: "draft", to: "sent", action: "send", requires: "quote:update" },
      { from: "sent", to: "accepted", action: "accept", requires: "quote:update" },
      { from: "sent", to: "declined", action: "decline", requires: "quote:update" },
      { from: "sent", to: "expired", action: "expire", requires: "quote:update" },
    ],
  },
};
