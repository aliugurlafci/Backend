/**
 * Comparing supplier offers, and turning the winner into an order.
 *
 * Three suppliers quote, the buyer picks one, and a month later nobody can say
 * what the other two offered or why this one won. That is the record an auditor
 * asks for and the record a buyer needs when the same thing is bought again.
 *
 * The comparison is deliberately NOT a ranking. Cheapest is not a decision:
 * an offer that arrives after the date the goods were needed is worth nothing,
 * and a supplier who cannot supply half the lines is not comparable to one who
 * can. So this reports the numbers side by side and marks the cheapest per line,
 * and a person decides — recording why in `awardReason`, which is the sentence
 * that has to survive.
 */
import type { EntityRecord } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import { getFinanceService } from "@/lib/finance/service";
import { BadRequestError, ConflictError } from "@/lib/enforcement/errors";
import { logger } from "@/lib/observability/logger";
import { recordPurchase } from "./supplier-price";

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface QuoteCell {
  quoteId: string;
  supplierId: string;
  supplierName: string | null;
  unitPrice: number;
  lineTotal: number;
  leadTimeDays: number | null;
  unavailable: boolean;
  /** True for the lowest priced supplier that can actually supply this line. */
  cheapest: boolean;
}

export interface ComparisonRow {
  requestLineId: string;
  description: string;
  qty: number;
  /** What the requester expected it to cost, for context beside the offers. */
  estimatedPrice: number | null;
  offers: QuoteCell[];
}

export interface QuoteSummary {
  quoteId: string;
  supplierId: string;
  supplierName: string | null;
  total: number;
  leadTimeDays: number | null;
  validUntil: string | null;
  /** True when `validUntil` has passed — the price is a memory, not an offer. */
  expired: boolean;
  status: string;
  /** How many requested lines this supplier priced. Partial cover matters. */
  linesQuoted: number;
  linesRequested: number;
}

export interface Comparison {
  request: EntityRecord;
  quotes: QuoteSummary[];
  rows: ComparisonRow[];
}

/**
 * Every offer against a request, line by line.
 *
 * Expired quotes are reported rather than filtered out: a buyer looking at the
 * comparison needs to see that the cheapest offer has lapsed, not to find the
 * options mysteriously reduced to two.
 */
export async function compareQuotes(ctx: RequestContext, requestId: string): Promise<Comparison> {
  const qe = await getQueryEngine();
  const request = await qe.get(ctx, "purchaseRequest", requestId);

  const [requestLines, quotes] = await Promise.all([
    qe.listComplete(ctx, "purchaseRequestLine", {
      filters: [{ field: "requestId", op: "eq", value: requestId }],
    }),
    qe.listComplete(ctx, "supplierQuote", {
      filters: [{ field: "requestId", op: "eq", value: requestId }],
    }),
  ]);
  const orderedLines = [...requestLines].sort((a, b) => Number(a.id) - Number(b.id));

  const quoteLines = quotes.length
    ? await qe.listComplete(ctx, "supplierQuoteLine", {
        filters: [{ field: "quoteId", op: "in", value: quotes.map((q) => String(q.id)) }],
      })
    : [];

  const supplierIds = [...new Set(quotes.map((q) => String(q.supplierId)))];
  const suppliers = supplierIds.length ? await qe.listByIds(ctx, "supplier", supplierIds) : [];
  const supplierName = new Map(suppliers.map((s) => [String(s.id), String(s.name)]));

  const today = ctx.at.slice(0, 10);
  const summaries: QuoteSummary[] = quotes.map((q) => {
    const mine = quoteLines.filter((l) => String(l.quoteId) === String(q.id) && !l.unavailable);
    return {
      quoteId: String(q.id),
      supplierId: String(q.supplierId),
      supplierName: supplierName.get(String(q.supplierId)) ?? null,
      total: round2(Number(q.total ?? 0)),
      leadTimeDays: q.leadTimeDays === null || q.leadTimeDays === undefined ? null : Number(q.leadTimeDays),
      validUntil: q.validUntil ? String(q.validUntil) : null,
      // ISO dates compare lexicographically — see `data/query`.
      expired: Boolean(q.validUntil) && String(q.validUntil) < today,
      status: String(q.status ?? "received"),
      linesQuoted: mine.length,
      linesRequested: orderedLines.length,
    };
  });

  const rows: ComparisonRow[] = orderedLines.map((line) => {
    // Sorted by quote, so the same supplier occupies the same column on every
    // row. A comparison grid whose columns shuffle per line is not a comparison.
    const forLine = quoteLines
      .filter((l) => String(l.requestLineId ?? "") === String(line.id))
      .sort((a, b) => Number(a.quoteId) - Number(b.quoteId));
    const offers: QuoteCell[] = forLine.map((l) => {
      const quote = quotes.find((q) => String(q.id) === String(l.quoteId));
      return {
        quoteId: String(l.quoteId),
        supplierId: String(quote?.supplierId ?? ""),
        supplierName: supplierName.get(String(quote?.supplierId ?? "")) ?? null,
        unitPrice: round2(Number(l.unitPrice ?? 0)),
        lineTotal: round2(Number(l.lineTotal ?? 0)),
        leadTimeDays: l.leadTimeDays === null || l.leadTimeDays === undefined ? null : Number(l.leadTimeDays),
        unavailable: Boolean(l.unavailable),
        cheapest: false,
      };
    });

    // Cheapest among those who can actually supply it. A supplier who marked the
    // line unavailable has offered nothing, and a zero on an unavailable line is
    // not a price of zero.
    const available = offers.filter((o) => !o.unavailable && o.unitPrice > 0);
    if (available.length) {
      const best = Math.min(...available.map((o) => o.unitPrice));
      // Every offer at the best price, not just the first — a tie is a tie, and
      // silently preferring whichever sorted first would hide it.
      for (const o of available) if (o.unitPrice === best) o.cheapest = true;
    }

    return {
      requestLineId: String(line.id),
      description: String(line.description ?? ""),
      qty: Number(line.qty ?? 0),
      estimatedPrice:
        line.estimatedPrice === null || line.estimatedPrice === undefined ? null : Number(line.estimatedPrice),
      offers,
    };
  });

  return { request, quotes: summaries, rows };
}

/**
 * Award a quote and raise the purchase order for it.
 *
 * The losing quotes are marked `declined` rather than deleted: they are the
 * record of what the alternatives were, which is the entire reason for
 * collecting them.
 *
 * The order is a DRAFT. Awarding is a purchasing decision; committing to it goes
 * through the same approval the order lifecycle already enforces, and skipping
 * that here would make the request route a way around it.
 */
export async function awardQuote(
  ctx: RequestContext,
  quoteId: string,
  reason?: string | null,
): Promise<{ purchaseOrderId: string }> {
  const qe = await getQueryEngine();
  const finance = await getFinanceService();
  const quote = await qe.get(ctx, "supplierQuote", quoteId);
  const requestId = String(quote.requestId);
  const request = await qe.get(ctx, "purchaseRequest", requestId);

  if (String(request.status) === "ordered") {
    throw new ConflictError("this request has already been ordered");
  }
  const lines = await qe.listComplete(ctx, "supplierQuoteLine", {
    filters: [{ field: "quoteId", op: "eq", value: quoteId }],
  });
  // Sorted, so the order reads in the same sequence as the quote it came from.
  // `listComplete` returns rows in whatever order the database chose, and a
  // purchase order whose lines are shuffled relative to the offer is a document
  // somebody has to reconcile by eye.
  const supply = [...lines]
    .filter((l) => !l.unavailable && Number(l.qty ?? 0) > 0)
    .sort((a, b) => Number(a.id) - Number(b.id));
  if (supply.length === 0) {
    throw new BadRequestError("this quote has nothing to order — every line is marked unavailable");
  }

  const warehouseId = request.warehouseId ? String(request.warehouseId) : "";
  if (!warehouseId) {
    // A purchase order receives into somewhere. Without one the receipt would
    // have nowhere to put the goods.
    throw new BadRequestError("set a warehouse on the request before ordering");
  }

  const po = await finance.createDocument(ctx, "purchaseOrder", "PO", {
    supplierId: String(quote.supplierId),
    warehouseId,
    branchId: request.branchId ?? null,
    currencyCode: quote.currencyCode,
    orderDate: ctx.at.slice(0, 10),
    status: "draft",
    notes: `${String(request.number ?? requestId)} — ${String(quote.number ?? quoteId)}`,
  });

  await finance.replaceLines(
    ctx,
    "purchaseOrder",
    "purchaseOrderLine",
    "poId",
    po.id,
    supply.map((l) => ({
      productId: (l.productId as string) ?? null,
      description: String(l.description),
      qty: Number(l.qty),
      uomId: (l.uomId as string) ?? null,
      unitPrice: Number(l.unitPrice),
      taxRate: Number(l.taxRate ?? 0),
    })),
  );

  // The winner, then the losers. Marked rather than removed — they are the
  // record of what the alternatives were.
  await qe.patchComputed(ctx, "supplierQuote", quoteId, {
    status: "awarded",
    awardReason: reason ?? null,
  });
  const others = await qe.listComplete(ctx, "supplierQuote", {
    filters: [{ field: "requestId", op: "eq", value: requestId }],
  });
  for (const other of others) {
    if (String(other.id) === String(quoteId)) continue;
    if (String(other.status) === "received") {
      await qe.patchComputed(ctx, "supplierQuote", String(other.id), { status: "declined" });
    }
  }

  await qe.patchComputed(ctx, "purchaseRequest", requestId, { status: "ordered" });

  // The agreed price on record, keyed to the supplier who won it. A quote that
  // was accepted IS an agreement, and the next reorder suggestion should not
  // have to go and ask again.
  await recordPurchase(
    ctx,
    String(quote.supplierId),
    supply
      .filter((l) => l.productId)
      .map((l) => ({
        productId: String(l.productId),
        unitCost: Number(l.unitPrice),
        uomId: (l.uomId as string) ?? null,
      })),
    ctx.at,
  );

  logger.info("quote awarded", { quoteId, requestId, purchaseOrderId: String(po.id), lines: supply.length });
  return { purchaseOrderId: String(po.id) };
}

/**
 * Turn an approved request straight into an order, skipping the quotes.
 *
 * For the routine case: a known product from a known supplier at a known price.
 * Insisting on a quote round for a box of paper is how a process stops being
 * used at all.
 */
export async function orderRequestDirect(
  ctx: RequestContext,
  requestId: string,
  supplierId: string,
): Promise<{ purchaseOrderId: string }> {
  const qe = await getQueryEngine();
  const finance = await getFinanceService();
  const request = await qe.get(ctx, "purchaseRequest", requestId);
  if (String(request.status) === "ordered") throw new ConflictError("this request has already been ordered");

  const warehouseId = request.warehouseId ? String(request.warehouseId) : "";
  if (!warehouseId) throw new BadRequestError("set a warehouse on the request before ordering");

  const lines = await qe.listComplete(ctx, "purchaseRequestLine", {
    filters: [{ field: "requestId", op: "eq", value: requestId }],
  });
  const wanted = lines.filter((l) => Number(l.qty ?? 0) > 0);
  if (wanted.length === 0) throw new BadRequestError("this request has no lines to order");

  const po = await finance.createDocument(ctx, "purchaseOrder", "PO", {
    supplierId,
    warehouseId,
    branchId: request.branchId ?? null,
    orderDate: ctx.at.slice(0, 10),
    status: "draft",
    notes: String(request.number ?? requestId),
  });

  // Priced from the supplier agreement where there is one, and from the
  // requester's estimate otherwise. The estimate is a guess and is labelled as
  // such on the request — but an order line needs a number, and a zero would
  // quietly turn into a zero-cost receipt.
  const { priceFor } = await import("./supplier-price");
  const priced = [];
  for (const l of wanted) {
    const agreement = l.productId ? await priceFor(ctx, supplierId, String(l.productId)) : null;
    priced.push({
      productId: (l.productId as string) ?? null,
      description: String(l.description),
      qty: Number(l.qty),
      uomId: (l.uomId as string) ?? null,
      unitPrice: Number(agreement?.unitPrice ?? l.estimatedPrice ?? 0),
      taxRate: 0,
    });
  }
  await finance.replaceLines(ctx, "purchaseOrder", "purchaseOrderLine", "poId", po.id, priced);
  await qe.patchComputed(ctx, "purchaseRequest", requestId, { status: "ordered" });

  logger.info("request ordered directly", { requestId, supplierId, purchaseOrderId: String(po.id) });
  return { purchaseOrderId: String(po.id) };
}
