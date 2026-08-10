/**
 * Unit-of-measure conversion.
 *
 * One invariant holds this together: **the stock ledger is always in base
 * units.** A line ordered by the case is converted before it reaches a balance
 * or a movement, never after. A balance that mixes cases and pieces cannot be
 * valued (what is the average cost of "3"?), cannot be picked, and cannot be
 * counted — and nothing about it looks wrong until somebody physically counts
 * the shelf.
 *
 * The arithmetic is separated as pure functions so the rule can be tested
 * without a database, and so the live path and any future replay path cannot
 * drift apart.
 */
import type { RequestContext } from "@/lib/context/types";
import type { EntityRecord } from "@/lib/metadata/types";
import { getQueryEngine } from "@/lib/data/store";
import { BadRequestError } from "@/lib/enforcement/errors";

/** One product's conversions, keyed by unit id. */
export interface UomFactors {
  /** Base units per unit of this uom. The base unit itself is 1. */
  factors: Map<string, number>;
  baseUomId: string | null;
}

/**
 * Quantity in `uomId` → quantity in base units.
 *
 * Rounded to six places, not to the unit's own precision: this is an
 * intermediate, and rounding it to the base unit's decimals here would lose the
 * fraction that a later line legitimately restores. The rounding that matters
 * happens once, when the movement is written.
 */
export function toBase(qty: number, factor: number): number {
  if (!Number.isFinite(qty)) throw new BadRequestError("quantity must be a number");
  if (!Number.isFinite(factor) || factor <= 0) {
    // A zero factor converts every quantity to no stock at all; a negative one
    // turns a receipt into an issue. Both corrupt the ledger silently, so
    // neither is allowed to reach it.
    throw new BadRequestError("unit conversion factor must be positive");
  }
  return Math.round(qty * factor * 1e6) / 1e6;
}

/** Base quantity → quantity in `uomId`, for display. */
export function fromBase(baseQty: number, factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) throw new BadRequestError("unit conversion factor must be positive");
  return Math.round((baseQty / factor) * 1e6) / 1e6;
}

/**
 * Whether a quantity is expressible in a unit of the given precision.
 *
 * Two and a half pieces is a data error: it produces a balance nobody can pick
 * and a count that can never agree. Two and a half kilos is ordinary. The unit
 * says which it is, which is why the precision is stored with the unit rather
 * than assumed globally.
 */
export function isRepresentable(qty: number, decimals: number): boolean {
  if (!Number.isFinite(qty)) return false;
  const scale = 10 ** Math.max(0, Math.min(4, Math.round(decimals)));
  return Math.abs(qty * scale - Math.round(qty * scale)) < 1e-9;
}

/** Round a quantity to what its unit can express. */
export function roundToUnit(qty: number, decimals: number): number {
  const scale = 10 ** Math.max(0, Math.min(4, Math.round(decimals)));
  return Math.round(qty * scale) / scale;
}

/**
 * Load a product's conversions.
 *
 * The base unit is inserted with a factor of 1 rather than stored: it is 1 by
 * definition, and a stored row invites somebody to edit it to something else,
 * which would silently rescale every existing balance for that product.
 */
export async function loadFactors(ctx: RequestContext, productId: string): Promise<UomFactors> {
  const qe = await getQueryEngine();
  const [product, rows] = await Promise.all([
    qe.get(ctx, "product", productId),
    qe.listComplete(ctx, "productUom", { filters: [{ field: "productId", op: "eq", value: productId }] }),
  ]);
  const baseUomId = product.baseUomId ? String(product.baseUomId) : null;
  const factors = new Map<string, number>();
  if (baseUomId) factors.set(baseUomId, 1);
  for (const row of rows) {
    const uomId = String(row.uomId);
    // A conversion row for the base unit is ignored rather than trusted: the
    // base unit is 1, and honouring a row that says otherwise would rescale the
    // product's entire history.
    if (uomId === baseUomId) continue;
    factors.set(uomId, Number(row.factor));
  }
  return { factors, baseUomId };
}

/**
 * Convert a document line's quantity into base units.
 *
 * `uomId` absent means the quantity is already in base units — which is what
 * every line written before this existed means, and what a line still means
 * when the product has no alternative units. That fallback is why introducing
 * this changes nothing for a catalogue that has not adopted it.
 */
export async function lineQtyInBase(
  ctx: RequestContext,
  productId: string,
  qty: number,
  uomId?: string | null,
): Promise<number> {
  if (!uomId) return qty;
  const { factors, baseUomId } = await loadFactors(ctx, productId);
  if (!baseUomId || uomId === baseUomId) return qty;
  const factor = factors.get(uomId);
  if (factor === undefined) {
    // Refused rather than assumed to be 1. Assuming would book twelve cases as
    // twelve pieces — a shortfall of eleven twelfths that surfaces as a
    // mysterious stock discrepancy weeks later.
    throw new BadRequestError(`this product has no conversion for the selected unit`).withKey("err.noUomConversion");
  }
  return toBase(qty, factor);
}

/** The unit code to show for a product — the referenced unit, else the legacy string. */
export function uomCodeOf(product: EntityRecord, base?: EntityRecord | null): string {
  if (base?.code) return String(base.code);
  return String(product.uom ?? "") || "EA";
}
