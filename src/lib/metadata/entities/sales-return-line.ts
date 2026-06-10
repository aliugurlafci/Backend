import type { EntityDef } from "../types";
import { priceLineFields } from "./shared";

/** Sales-return line item (child of salesReturn). Same priced-line shape as sales lines. */
export const salesReturnLineEntity: EntityDef = {
  name: "salesReturnLine",
  label: "Sales Return Line",
  pluralLabel: "Sales Return Lines",
  group: "sales",
  system: true,
  titleField: "description",
  parent: { entity: "salesReturn", field: "salesReturnId" },
  fields: priceLineFields({ parentField: "salesReturnId", parentLabel: "Return", parentEntity: "salesReturn", qtyDefault: 1 }),
};
