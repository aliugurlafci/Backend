/**
 * Which price applies.
 *
 * A price list decides the DEFAULT unit price for a line. It does not force one:
 * the line still carries `unitPrice`, and someone with the authority may change
 * it. That distinction is deliberate — a system that cannot be overridden gets
 * worked around, usually by editing the price list.
 *
 * The resolution order is written down here rather than emerging from whatever
 * order the rows came back in, because "why did it charge that?" has to have one
 * answer. From most specific to least:
 *
 *   1. The customer's own price list, at the best quantity break they qualify for
 *   2. The default price list, same rule
 *   3. The product's own `unitPrice`
 *
 * `resolvePrice` is pure and takes the candidate rows; reading them is the
 * service's job. That split is what makes the decision testable without a
 * database, which matters because every one of these branches decides money.
 */

/** A row in a price list: what this product costs on this list, from this quantity up. */
export interface PriceRule {
  priceListId: string;
  productId: string;
  /**
   * Smallest quantity this rule applies from — the quantity break.
   *
   * A list with rows at 1, 10 and 100 prices an order of 50 at the "10" row: the
   * highest break the order actually reaches. Treating it as an exact match
   * would leave most quantities unpriced.
   */
  minQty: number;
  unitPrice: number;
  /** Optional line discount the rule carries with it. */
  discountRate?: number;
}

/** A price list, as far as resolution is concerned. */
export interface PriceListMeta {
  id: string;
  currencyCode: string;
  active: boolean;
  /** Inclusive; absent means no bound. */
  validFrom?: string | null;
  validTo?: string | null;
  /** The list used when a customer has none of their own. */
  isDefault?: boolean;
}

export interface PriceQuery {
  productId: string;
  qty: number;
  /** The currency the DOCUMENT is in. A list in another currency does not apply. */
  currencyCode: string;
  /** ISO date the document is dated — validity is judged against this, not "now". */
  onDate: string;
  /** The customer's assigned list, if they have one. */
  customerPriceListId?: string | null;
}

export interface ResolvedPrice {
  unitPrice: number;
  discountRate: number;
  /** Where the number came from — shown in the UI and worth having in a log. */
  source: "customer-list" | "default-list" | "product";
  priceListId: string | null;
}

/**
 * Is this list usable for a document dated `onDate`, in `currencyCode`?
 *
 * Currency is a hard filter, never a conversion. Converting here would invent an
 * exchange rate at the moment a line is priced, bury it in a unit price, and
 * leave nothing to reconcile against — and this system's ledger does not convert
 * between currencies at all yet. A EUR list simply does not apply to a TRY
 * document, and the product price is used instead.
 */
export function listApplies(list: PriceListMeta, currencyCode: string, onDate: string): boolean {
  if (!list.active) return false;
  if (list.currencyCode !== currencyCode) return false;
  // ISO-8601 dates compare correctly as strings, which is why they are stored
  // that way; `slice(0, 10)` guards a full timestamp being passed in.
  const day = onDate.slice(0, 10);
  if (list.validFrom && day < String(list.validFrom).slice(0, 10)) return false;
  if (list.validTo && day > String(list.validTo).slice(0, 10)) return false;
  return true;
}

/**
 * The best rule for a quantity: the highest break at or below it.
 *
 * Ties are broken by the lower price. Two rows at the same break is a
 * configuration mistake, and charging the customer the cheaper of the two is the
 * failure mode that does not end in an argument.
 */
function bestRuleFor(rules: PriceRule[], qty: number): PriceRule | null {
  let best: PriceRule | null = null;
  for (const rule of rules) {
    if (rule.minQty > qty) continue;
    if (!best) {
      best = rule;
      continue;
    }
    if (rule.minQty > best.minQty || (rule.minQty === best.minQty && rule.unitPrice < best.unitPrice)) {
      best = rule;
    }
  }
  return best;
}

export function resolvePrice(
  query: PriceQuery,
  lists: PriceListMeta[],
  rules: PriceRule[],
  productUnitPrice: number,
): ResolvedPrice {
  const usable = new Map(
    lists.filter((l) => listApplies(l, query.currencyCode, query.onDate)).map((l) => [l.id, l]),
  );
  const forProduct = rules.filter((r) => r.productId === query.productId && usable.has(r.priceListId));

  // 1. The customer's own list wins outright when it prices this product. A
  //    negotiated price is not a starting point to be improved on by a general
  //    list — it is the agreement.
  if (query.customerPriceListId && usable.has(query.customerPriceListId)) {
    const own = bestRuleFor(
      forProduct.filter((r) => r.priceListId === query.customerPriceListId),
      query.qty,
    );
    if (own) {
      return {
        unitPrice: own.unitPrice,
        discountRate: own.discountRate ?? 0,
        source: "customer-list",
        priceListId: own.priceListId,
      };
    }
  }

  // 2. The default list.
  const defaults = forProduct.filter((r) => usable.get(r.priceListId)?.isDefault);
  const fallback = bestRuleFor(defaults, query.qty);
  if (fallback) {
    return {
      unitPrice: fallback.unitPrice,
      discountRate: fallback.discountRate ?? 0,
      source: "default-list",
      priceListId: fallback.priceListId,
    };
  }

  // 3. The product's own price. Always defined, so pricing never fails — a line
  //    that could not be priced would block a sale over a missing list row.
  return { unitPrice: productUnitPrice, discountRate: 0, source: "product", priceListId: null };
}
