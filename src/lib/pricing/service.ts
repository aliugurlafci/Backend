/**
 * Price lookup against stored lists.
 *
 * Reads the candidate rows and hands them to `resolvePrice`, which owns the
 * decision. The split is the point: the ordering rules are pure and tested
 * without a database, and this file only has to fetch the right rows.
 *
 * Reads are cached briefly. Pricing happens per LINE — a twenty-line quote asks
 * twenty times, and a POS terminal asks on every scan — so the alternative is
 * the same three queries repeated for a page of work. Price lists change rarely
 * and a few seconds of staleness costs nothing; the cache is invalidated on
 * write for the case where it would.
 */
import type { RequestContext } from "@/lib/context/types";
import type { EntityRecord } from "@/lib/metadata/types";
import { getQueryEngine } from "@/lib/data/store";
import { cache } from "@/lib/cache/cache";
import { resolvePrice, type PriceListMeta, type PriceRule, type ResolvedPrice } from "./resolve";

/**
 * How long the lists and their rows are trusted.
 *
 * Short enough that an edited price is live almost immediately, long enough to
 * collapse a document's worth of lookups into one read.
 */
const TTL_MS = 15_000;

function listsKey(ctx: RequestContext): string {
  return `pricing:lists:${ctx.tenantId}:${ctx.orgId}`;
}

function rulesKey(ctx: RequestContext, productId: string): string {
  return `pricing:rules:${ctx.tenantId}:${ctx.orgId}:${productId}`;
}

async function activeLists(ctx: RequestContext): Promise<PriceListMeta[]> {
  return cache.wrap(listsKey(ctx), TTL_MS, async () => {
    const qe = await getQueryEngine();
    // `listComplete` rather than a page: a truncated list would silently drop a
    // customer's negotiated prices and charge them the default instead.
    const rows = await qe.listComplete(ctx, "priceList", {
      filters: [{ field: "active", op: "eq", value: true }],
    });
    return rows.map((r: EntityRecord) => ({
      id: String(r.id),
      currencyCode: String(r.currencyCode ?? ""),
      active: r.active !== false,
      validFrom: r.validFrom ? String(r.validFrom) : null,
      validTo: r.validTo ? String(r.validTo) : null,
      isDefault: r.isDefault === true,
    }));
  });
}

async function rulesFor(ctx: RequestContext, productId: string): Promise<PriceRule[]> {
  return cache.wrap(rulesKey(ctx, productId), TTL_MS, async () => {
    const qe = await getQueryEngine();
    const rows = await qe.listComplete(ctx, "priceListItem", {
      filters: [{ field: "productId", op: "eq", value: productId }],
    });
    return rows.map((r: EntityRecord) => ({
      priceListId: String(r.priceListId),
      productId: String(r.productId),
      minQty: Number(r.minQty ?? 1),
      unitPrice: Number(r.unitPrice ?? 0),
      discountRate: Number(r.discountRate ?? 0),
    }));
  });
}

export interface PriceRequest {
  productId: string;
  qty: number;
  currencyCode: string;
  /** Document date. Validity is judged against this, so a backdated invoice prices as of then. */
  onDate: string;
  /** Customer, if there is one — their assigned list is looked up from it. */
  accountId?: string | null;
}

/**
 * The price that applies, and where it came from.
 *
 * Never throws and never returns nothing: an unknown product falls back to a
 * zero price rather than failing, because a pricing lookup that can block a sale
 * is a worse outcome than a line someone has to correct.
 */
export async function priceFor(ctx: RequestContext, req: PriceRequest): Promise<ResolvedPrice> {
  const qe = await getQueryEngine();

  const product = await qe.get(ctx, "product", req.productId).catch(() => null);
  const productUnitPrice = Number(product?.unitPrice ?? 0);

  let customerPriceListId: string | null = null;
  if (req.accountId) {
    const account = await qe.get(ctx, "account", req.accountId).catch(() => null);
    customerPriceListId = account?.priceListId ? String(account.priceListId) : null;
  }

  const [lists, rules] = await Promise.all([activeLists(ctx), rulesFor(ctx, req.productId)]);
  return resolvePrice(
    {
      productId: req.productId,
      qty: req.qty,
      currencyCode: req.currencyCode,
      onDate: req.onDate,
      customerPriceListId,
    },
    lists,
    rules,
    productUnitPrice,
  );
}

/**
 * Drop the cached lists and rows.
 *
 * Called when a price list or one of its rows changes — the alternative is up to
 * `TTL_MS` of a corrected price still being charged, which is exactly the window
 * someone would notice.
 */
export async function invalidatePricing(ctx: RequestContext): Promise<void> {
  await cache.invalidatePrefix(`pricing:lists:${ctx.tenantId}:${ctx.orgId}`);
  await cache.invalidatePrefix(`pricing:rules:${ctx.tenantId}:${ctx.orgId}`);
}
