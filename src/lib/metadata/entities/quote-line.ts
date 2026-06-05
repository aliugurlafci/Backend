import type { EntityDef } from "../types";
import { priceLineFields } from "./shared";

/** Phase F4 — Quote line item (child of quote). Hidden from nav; managed via the
 *  quote editor. `lineTotal` is computed (qty × price + tax). */
export const quoteLineEntity: EntityDef = {
  name: "quoteLine",
  label: "Quote Line",
  pluralLabel: "Quote Lines",
  group: "finance",
  system: true,
  titleField: "description",
  parent: { entity: "quote", field: "quoteId" },
  fields: priceLineFields({ parentField: "quoteId", parentLabel: "Quote", parentEntity: "quote", qtyDefault: 1 }),
};
