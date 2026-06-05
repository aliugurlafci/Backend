import type { EntityDef } from "../types";
import { priceLineFields } from "./shared";

/** Phase F5 — Invoice line item (child of invoice). */
export const invoiceLineEntity: EntityDef = {
  name: "invoiceLine",
  label: "Invoice Line",
  pluralLabel: "Invoice Lines",
  group: "finance",
  system: true,
  titleField: "description",
  parent: { entity: "invoice", field: "invoiceId" },
  fields: priceLineFields({ parentField: "invoiceId", parentLabel: "Invoice", parentEntity: "invoice", qtyDefault: 1 }),
};
