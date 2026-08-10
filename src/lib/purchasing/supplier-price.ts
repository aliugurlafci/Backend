/**
 * Supplier agreements: what a given supplier charges for a given product.
 *
 * Buying prices lived on `product.costPrice` — one number for a thing three
 * suppliers sell at three prices. "Who is cheapest" was not a question the
 * system could answer, and the number it did hold was whichever price was typed
 * in last.
 *
 * Two facts are kept apart on purpose: the AGREED price, which a person
 * negotiated and enters, and the price we LAST ACTUALLY PAID, which the receipt
 * writes and nobody types. Keeping both is what makes "they are charging more
 * than we agreed" a question with an answer; collapsing them into one field is
 * how the discrepancy becomes invisible.
 */
import type { EntityRecord } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import { systemContext } from "@/lib/context/resolver";
import { logger } from "@/lib/observability/logger";

const ENTITY = "supplierProduct";
const round2 = (n: number): number => Math.round(n * 100) / 100;

export const supplyKeyOf = (supplierId: string, productId: string): string => `${supplierId}:${productId}`;

/**
 * The agreement in force for this supplier and product on a given date.
 *
 * Date-bounded: a contract price expires, and without checking the window the
 * old price stays authoritative for ever — nobody notices until the invoice
 * disagrees with the order. An agreement with no dates is treated as always
 * valid, which is what an open-ended arrangement means.
 */
export async function priceFor(
  ctx: RequestContext,
  supplierId: string,
  productId: string,
  onDate?: string,
): Promise<EntityRecord | null> {
  const qe = await getQueryEngine();
  const page = await qe.list(ctx, ENTITY, {
    filters: [
      { field: "supplyKey", op: "eq", value: supplyKeyOf(supplierId, productId) },
      { field: "active", op: "eq", value: true },
    ],
    pageSize: 1,
  });
  const row = page.items[0];
  if (!row) return null;

  const day = (onDate ?? ctx.at).slice(0, 10);
  // ISO dates compare lexicographically, which is why they are stored as
  // strings — see `data/query`. `validTo` is INCLUSIVE here: a contract that
  // says "until 31 December" is good on the 31st.
  if (row.validFrom && day < String(row.validFrom)) return null;
  if (row.validTo && day > String(row.validTo)) return null;
  return row;
}

/**
 * Every supplier who can supply this product, cheapest first.
 *
 * The preferred one leads regardless of price: somebody chose it, and quality,
 * reliability and payment terms are reasons this table does not model. Price
 * orders the rest.
 */
export async function suppliersFor(ctx: RequestContext, productId: string): Promise<EntityRecord[]> {
  const qe = await getQueryEngine();
  const rows = await qe.listComplete(ctx, ENTITY, {
    filters: [
      { field: "productId", op: "eq", value: productId },
      { field: "active", op: "eq", value: true },
    ],
  });
  return [...rows].sort(
    (a, b) =>
      Number(Boolean(b.preferred)) - Number(Boolean(a.preferred)) ||
      Number(a.unitPrice ?? 0) - Number(b.unitPrice ?? 0),
  );
}

/**
 * Record what a receipt actually paid.
 *
 * Called after a goods receipt posts, under a system context: the ledger writes
 * this, not a user, and a buyer who cannot edit supplier agreements must still
 * have the receipt update what was paid.
 *
 * Creates the agreement row if there is none. A first purchase from a new
 * supplier is exactly when you want the price on record, and requiring somebody
 * to have set one up first means the common case records nothing.
 */
export async function recordPurchase(
  ctx: RequestContext,
  supplierId: string,
  lines: readonly { productId: string; unitCost: number; uomId?: string | null }[],
  at?: string,
): Promise<number> {
  if (!supplierId || lines.length === 0) return 0;
  const qe = await getQueryEngine();
  const sys = systemContext(ctx.tenantId, ctx.orgId, {
    userId: ctx.userId,
    displayName: ctx.displayName,
    email: ctx.email,
  });
  const when = at ?? ctx.at;
  let written = 0;

  for (const line of lines) {
    if (!line.productId || !(Number(line.unitCost) > 0)) continue;
    const key = supplyKeyOf(supplierId, String(line.productId));
    try {
      const existing = (
        await qe.list(sys, ENTITY, { filters: [{ field: "supplyKey", op: "eq", value: key }], pageSize: 1 })
      ).items[0];

      if (existing) {
        // Only the "last paid" pair. The AGREED price is somebody's negotiated
        // figure and must not be overwritten by what an invoice happened to
        // charge — that would erase the very discrepancy worth seeing.
        await qe.patchComputed(sys, ENTITY, String(existing.id), {
          lastPurchasePrice: round2(Number(line.unitCost)),
          lastPurchaseAt: when,
        });
      } else {
        await qe.createWithComputed(
          sys,
          ENTITY,
          {
            supplierId,
            productId: String(line.productId),
            // Seeded from what was paid, because on a first purchase that IS
            // the agreement as far as anybody knows.
            unitPrice: round2(Number(line.unitCost)),
            uomId: line.uomId ?? null,
            active: true,
            preferred: false,
          },
          {
            supplyKey: key,
            lastPurchasePrice: round2(Number(line.unitCost)),
            lastPurchaseAt: when,
          },
        );
      }
      written += 1;
    } catch (error) {
      // Never let price bookkeeping fail a goods receipt. The stock is on the
      // shelf and the GL is posted; a missing price history row is a reporting
      // gap, not a reason to unwind a receipt.
      logger.warn("could not record supplier price", {
        supplierId,
        productId: String(line.productId),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return written;
}
