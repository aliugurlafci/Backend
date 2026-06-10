import type { EntityDef } from "../types";
import { priceLineFields } from "./shared";

/** Cart line item (child of cart). Same priced-line shape as quote/invoice lines. */
export const cartLineEntity: EntityDef = {
  name: "cartLine",
  label: "Cart Line",
  pluralLabel: "Cart Lines",
  group: "sales",
  system: true,
  titleField: "description",
  parent: { entity: "cart", field: "cartId" },
  fields: priceLineFields({ parentField: "cartId", parentLabel: "Cart", parentEntity: "cart", qtyDefault: 1 }),
};
