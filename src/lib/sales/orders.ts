/**
 * Sales orders and the delivery notes that fill them.
 *
 * The chain ran `deal → quote → invoice`, which works only when everything is
 * quoted, agreed and shipped in one step. It skips what a distributor actually
 * does: take an order now, ship it in two loads over three weeks, and invoice
 * what left the building.
 *
 * Three rules hold this together, and each closes a defect this codebase has
 * already been bitten by once:
 *
 *  - **Confirming HOLDS stock.** That is the difference between an order and a
 *    quote. It uses the reservation module, so two orders cannot promise the
 *    same last unit — the check happens under a row lock, not in this file.
 *  - **Goods leave on the delivery note, not the invoice.** A load goes out on
 *    Tuesday and is invoiced at month end; a system that issues stock only when
 *    it invoices reports three weeks of delivered goods as still on the shelf.
 *  - **Fulfilment is tracked per ORDER LINE, never per product.** The same
 *    product can sit on an order twice at different prices. Matching on the
 *    product collapses them, so the shipped quantity cannot be attributed and
 *    the cost comes from whichever line was read last — exactly the defect
 *    found and fixed on goods receipts.
 */
import type { RequestContext } from "@/lib/context/types";
import type { EntityRecord } from "@/lib/metadata/types";
import { getQueryEngine } from "@/lib/data/store";
import { getFinanceService, type LineInput } from "@/lib/finance/service";
import { docTotals, lineTotals, type LineInput as TotalsLineInput } from "@/lib/finance/totals";
import { getInventoryService } from "@/lib/inventory/service";
import { collapseMovementLines } from "@/lib/inventory/movement-lines";
import { release, reserve } from "@/lib/inventory/reservations";
import { pickLots } from "@/lib/inventory/lots";
import { BadRequestError, ConflictError } from "@/lib/enforcement/errors";
import { logger } from "@/lib/observability/logger";
import { BASE_CURRENCY } from "@/lib/config/env";

const ORDER = "salesOrder";
const ORDER_LINE = "salesOrderLine";
const NOTE = "deliveryNote";
const NOTE_LINE = "deliveryNoteLine";

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Order lines, oldest first — the order they were negotiated in. */
async function orderLines(ctx: RequestContext, orderId: string): Promise<EntityRecord[]> {
  const qe = await getQueryEngine();
  const rows = await qe.listComplete(ctx, ORDER_LINE, {
    filters: [{ field: "orderId", op: "eq", value: orderId }],
  });
  // SORTED, because the fallback in `resolveLine` depends on "oldest first" and
  // an unsorted read returns whatever order the database chose.
  return [...rows].sort((a, b) => Number(a.id) - Number(b.id));
}

/** Base quantity still to ship on a line. */
const outstandingOf = (line: EntityRecord): number =>
  round4(Number(line.qtyBase ?? line.qty ?? 0) - Number(line.qtyShipped ?? 0));

/**
 * Create an order with its lines.
 *
 * Draft: nothing is held until it is confirmed, because a draft is still being
 * edited and holding stock for it would let an abandoned order starve the ones
 * somebody means to ship.
 */
export async function createOrder(
  ctx: RequestContext,
  header: Record<string, unknown>,
  lines: LineInput[],
): Promise<EntityRecord> {
  const finance = await getFinanceService();
  const order = await finance.createDocument(ctx, ORDER, "SO", { ...header, status: "draft" });
  if (lines.length) await finance.replaceLines(ctx, ORDER, ORDER_LINE, "orderId", order.id, lines);
  const qe = await getQueryEngine();
  return qe.get(ctx, ORDER, order.id);
}

/**
 * Confirm an order, holding the stock it promises.
 *
 * Every line is reserved or none is. A partial hold would tell the salesperson
 * the order is confirmed while quietly failing to secure half of it, and they
 * would find out at dispatch — which is the situation reservations exist to
 * prevent.
 */
export async function confirmOrder(ctx: RequestContext, orderId: string): Promise<EntityRecord> {
  const qe = await getQueryEngine();
  const order = await qe.get(ctx, ORDER, orderId);
  if (String(order.status) !== "draft") {
    throw new ConflictError(`only a draft order can be confirmed (this one is ${String(order.status)})`).withKey("err.orderNotDraftConfirm", { status: String(order.status) });
  }
  // Held BEFORE the status moves, so an order that cannot be covered fails
  // loudly and stays a draft. The other way round the salesperson is told it is
  // confirmed and finds out at dispatch, which is the situation reservations
  // exist to prevent.
  await reserveOrderStock(ctx, orderId);
  return qe.patchComputed(ctx, ORDER, orderId, { status: "confirmed" });
}

/**
 * Hold the stock an order promises. No status change.
 *
 * Split from `confirmOrder` for the reason `applyGRN` was split from `postGRN`:
 * the generic lifecycle endpoint writes the status FIRST and then emits
 * `salesOrder.confirm`, at which point a status guard would make the whole thing
 * a silent no-op — an order marked confirmed holding nothing at all.
 *
 * Idempotent: `reserve` replaces a document's existing hold rather than adding
 * to it, so running this twice holds the same quantity once.
 */
export async function reserveOrderStock(ctx: RequestContext, orderId: string): Promise<number> {
  const qe = await getQueryEngine();
  const order = await qe.get(ctx, ORDER, orderId);
  const warehouseId = order.warehouseId ? String(order.warehouseId) : "";
  if (!warehouseId) throw new BadRequestError("set a warehouse before confirming — stock is held against one");

  const lines = await orderLines(ctx, orderId);
  const stockLines = lines.filter((l) => l.productId && outstandingOf(l) > 1e-9);

  // Everything or nothing, inside one transaction: the first line that cannot be
  // held aborts the confirmation and unwinds what was already taken. A partial
  // hold would secure half an order and say nothing about the other half.
  //
  // What is OUTSTANDING, not what was ordered — so re-running this on a
  // part-shipped order holds the remainder rather than re-reserving goods that
  // have already left the building.
  await qe.runInTransaction(async () => {
    for (const line of stockLines) {
      await reserve(ctx, {
        productId: String(line.productId),
        warehouseId,
        qty: outstandingOf(line),
        // Keyed by LINE, so two lines of the same product hold separately and a
        // later edit to one does not silently release the other.
        refType: "salesOrderLine",
        refId: String(line.id),
        branchId: (order.branchId as string) ?? null,
      });
    }
  });
  return stockLines.length;
}

export interface FulfilmentLine {
  orderLineId: string;
  productId: string | null;
  description: string;
  /** Ordered, shipped and outstanding — all in BASE units, as the ledger is. */
  qtyBase: number;
  qtyShipped: number;
  outstanding: number;
}

/**
 * What an order still owes, line by line.
 *
 * The picker's view, and the answer to "can this go out today". Reported per
 * LINE rather than rolled up per product because that is the granularity the
 * warehouse ships at — two lines of the same item at different prices are two
 * separate promises, and a rolled-up figure cannot say which one is short.
 */
export async function orderFulfilment(
  ctx: RequestContext,
  orderId: string,
): Promise<{ salesOrder: EntityRecord; lines: FulfilmentLine[] }> {
  const qe = await getQueryEngine();
  const order = await qe.get(ctx, ORDER, orderId);
  const lines = await orderLines(ctx, orderId);
  return {
    salesOrder: order,
    lines: lines.map((l) => ({
      orderLineId: String(l.id),
      productId: l.productId ? String(l.productId) : null,
      description: String(l.description ?? ""),
      qtyBase: round4(Number(l.qtyBase ?? l.qty ?? 0)),
      qtyShipped: round4(Number(l.qtyShipped ?? 0)),
      outstanding: outstandingOf(l),
    })),
  };
}

/** Give back everything an order is holding — a cancellation, or an edit. */
export async function releaseOrder(ctx: RequestContext, orderId: string): Promise<number> {
  const lines = await orderLines(ctx, orderId);
  let released = 0;
  for (const line of lines) released += await release(ctx, "salesOrderLine", String(line.id));
  return released;
}

export interface DeliveryLineInput {
  /** Which order line this fills. Omitted, the oldest line for the product is taken. */
  orderLineId?: string | null;
  productId: string;
  /** In the order line's units — the caller ships what was ordered. */
  qty: number;
  description?: string;
}

/**
 * Raise a delivery note against an order.
 *
 * Quantities are checked against what each LINE still owes, consumed as the
 * rows are walked — so two rows for the same product cannot both be measured
 * against the same untouched outstanding figure and both pass.
 */
export async function createDelivery(
  ctx: RequestContext,
  orderId: string,
  header: Record<string, unknown>,
  lines: DeliveryLineInput[],
): Promise<EntityRecord> {
  const qe = await getQueryEngine();
  const order = await qe.get(ctx, ORDER, orderId);
  const status = String(order.status);
  if (status !== "confirmed" && status !== "partial") {
    throw new ConflictError(`only a confirmed order can be delivered (this one is ${status})`).withKey("err.orderNotConfirmedDeliver", { status });
  }

  const poLines = await orderLines(ctx, orderId);
  const byLine = new Map(poLines.map((l) => [String(l.id), l]));
  const remaining = new Map(poLines.map((l) => [String(l.id), outstandingOf(l)]));

  const valid = lines.filter((l) => l.productId && Number(l.qty) > 0);
  if (!valid.length) throw new BadRequestError("add at least one line to deliver");

  const resolveLine = (l: DeliveryLineInput): string => {
    if (l.orderLineId && byLine.has(String(l.orderLineId))) return String(l.orderLineId);
    const match = poLines.find(
      (ol) => String(ol.productId) === String(l.productId) && (remaining.get(String(ol.id)) ?? 0) > 1e-9,
    );
    if (!match) {
      throw new ConflictError(
        `product is not on order ${String(order.number ?? orderId)}, or has nothing left to ship`,
      ).withKey("err.productNotOnOrder", { number: String(order.number ?? orderId) });
    }
    return String(match.id);
  };

  const assigned = valid.map((l) => ({ line: l, orderLineId: resolveLine(l) }));
  for (const { line, orderLineId } of assigned) {
    const left = remaining.get(orderLineId) ?? 0;
    const orderLine = byLine.get(orderLineId);
    // The delivery is entered in the ORDER's units, so the comparison happens in
    // base units — twelve pieces against a line of two cases.
    const factor = Number(orderLine?.qtyBase ?? orderLine?.qty ?? 1) / Number(orderLine?.qty ?? 1) || 1;
    const wantBase = round4(Number(line.qty) * factor);
    if (wantBase > left + 1e-9) {
      throw new ConflictError(`delivering ${line.qty} exceeds the ${round4(left / factor)} still outstanding on that line`).withKey("err.deliverExceeds", { qty: line.qty, left: round4(left / factor) });
    }
    remaining.set(orderLineId, round4(left - wantBase));
  }

  const finance = await getFinanceService();
  const note = await finance.createDocument(ctx, NOTE, "IRS", {
    orderId,
    accountId: order.accountId,
    warehouseId: order.warehouseId,
    branchId: order.branchId ?? null,
    status: "draft",
    dispatchedAt: ctx.at,
    ...header,
  });

  const priced: TotalsLineInput[] = [];
  for (const { line, orderLineId } of assigned) {
    const orderLine = byLine.get(orderLineId);
    const factor = Number(orderLine?.qtyBase ?? orderLine?.qty ?? 1) / Number(orderLine?.qty ?? 1) || 1;
    // Priced from the ORDER, so the invoice raised from this note matches what
    // the customer agreed to rather than today's list price. A discount
    // negotiated in March survives a load that ships in May.
    const pricing: TotalsLineInput = {
      qty: line.qty,
      unitPrice: Number(orderLine?.unitPrice ?? 0),
      taxRate: Number(orderLine?.taxRate ?? 0),
      discountRate: Number(orderLine?.discountRate ?? 0),
      // The absolute discount is PRO-RATED by how much of the line is in this
      // load. Copying it whole would apply "150 lira off" to each of two partial
      // deliveries and give the customer the discount twice.
      discountAmount: round2(
        Number(orderLine?.discountAmount ?? 0) *
          (Number(orderLine?.qty ?? 0) > 0 ? line.qty / Number(orderLine?.qty ?? 1) : 0),
      ),
    };
    priced.push(pricing);
    const { lineTotal, lineDiscount } = lineTotals(pricing);
    await qe.createWithComputed(
      ctx,
      NOTE_LINE,
      {
        noteId: note.id,
        orderLineId,
        productId: line.productId,
        description: line.description ?? String(orderLine?.description ?? ""),
        qty: line.qty,
        uomId: orderLine?.uomId ?? null,
        unitPrice: pricing.unitPrice,
        discountRate: pricing.discountRate,
        discountAmount: pricing.discountAmount,
        taxRate: pricing.taxRate,
      },
      { qtyBase: round4(Number(line.qty) * factor), lineTotal, discountTotal: lineDiscount },
    );
  }

  const totals = docTotals(priced, {
    discountRate: Number(order.discountRate ?? 0),
    discountAmount: Number(order.discountAmount ?? 0),
  });
  await qe.patchComputed(ctx, NOTE, note.id, {
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    total: totals.total,
  });
  return qe.get(ctx, NOTE, note.id);
}

/**
 * Dispatch: the goods leave.
 *
 * Issues the stock, advances what each order line has shipped, and settles the
 * hold each line was under.
 *
 * The whole thing is one transaction. Releasing a hold and then failing to issue
 * the stock would leave the units unheld and unshipped — free for somebody else
 * to promise while they are sitting on the van.
 *
 * Split from the lifecycle transition for the same reason `applyGRN` was: the
 * transition writes the status first, so a status guard inside here would make
 * the lifecycle path a silent no-op.
 *
 * Returns the cost of what left, for the caller to post to the GL. The ledger
 * computes that number once, here, and hands it over — the alternative is the
 * GL deriving it a second time from the same lines and the two answers drifting,
 * which is the defect the costing engine was rebuilt to remove.
 */
export async function applyDelivery(ctx: RequestContext, noteId: string): Promise<number> {
  const qe = await getQueryEngine();
  const note = await qe.get(ctx, NOTE, noteId);
  const lines = await qe.listComplete(ctx, NOTE_LINE, {
    filters: [{ field: "noteId", op: "eq", value: noteId }],
  });
  const inventory = await getInventoryService();
  const warehouseId = String(note.warehouseId);
  const shipped = lines.filter((l) => l.productId && Number(l.qtyBase ?? l.qty ?? 0) > 0);
  let cost = 0;

  await qe.runInTransaction(async () => {
    // Holds first, and per ORDER LINE — the unit of a reservation.
    //
    // A partial delivery SHRINKS the hold rather than dropping it: the rest of
    // the line has not shipped and still needs its stock kept back. `reserve`
    // replaces a hold with a new quantity, so re-reserving the remainder is the
    // shrink; only a line that is now fully shipped is released outright.
    //
    // Before the issue, not after. The issue reduces on-hand while the hold
    // still counts against it, and in that window the balance reports less
    // available than exists — briefly promising nothing to a caller who could
    // have had it.
    for (const line of shipped) {
      if (!line.orderLineId) continue;
      const orderLine = await qe.get(ctx, ORDER_LINE, String(line.orderLineId));
      const qtyBase = Number(line.qtyBase ?? line.qty ?? 0);
      const stillDue = round4(outstandingOf(orderLine) - qtyBase);
      if (stillDue > 1e-9) {
        await reserve(ctx, {
          productId: String(line.productId),
          warehouseId,
          qty: stillDue,
          refType: "salesOrderLine",
          refId: String(line.orderLineId),
          branchId: (note.branchId as string) ?? null,
        });
      } else {
        // `consumed`, not `released`: the issue below already takes the units
        // out of on-hand, and returning the hold as if the sale fell through
        // would credit the same units twice.
        await release(ctx, "salesOrderLine", String(line.orderLineId), "consumed");
      }
      await qe.patchComputed(ctx, ORDER_LINE, String(line.orderLineId), {
        qtyShipped: round4(Number(orderLine.qtyShipped ?? 0) + qtyBase),
      });
    }

    // One movement per product — the same collapse the invoice and receipt
    // paths make, and for the same reason: `writeMovement` is idempotent on
    // (ref, refType, product, warehouse, type), so two note lines for the same
    // product would have had the second returned as a duplicate and never
    // issued. Two order lines of one product at different prices is exactly the
    // case this document exists to ship.
    const movements = collapseMovementLines(
      shipped.map((l) => ({
        productId: String(l.productId),
        warehouseId,
        qtyBase: -Number(l.qtyBase ?? l.qty ?? 0),
      })),
    );

    const productIds = [...new Set(movements.map((m) => m.productId))];
    const products = productIds.length ? await qe.listByIds(ctx, "product", productIds) : [];
    const tracksLots = new Set(products.filter((p) => p.trackLots).map((p) => String(p.id)));

    // A lot-tracked product is picked before it is issued: its stock sits in
    // several batches at once, and the movement has to name which. FEFO decides
    // — left to a person it is whichever box is nearest the door, and the oldest
    // stock stays at the back until it expires.
    const picked: { productId: string; warehouseId: string; lotId: string | null; qtyBase: number }[] = [];
    for (const mv of movements) {
      if (!tracksLots.has(mv.productId)) {
        picked.push({ ...mv, lotId: null });
        continue;
      }
      const allocations = await pickLots(ctx, mv.productId, mv.warehouseId, Math.abs(mv.qtyBase));
      for (const a of allocations) {
        picked.push({ productId: mv.productId, warehouseId: mv.warehouseId, lotId: a.lotId, qtyBase: -a.qty });
      }
    }

    for (const mv of picked) {
      const result = await inventory.writeMovement(ctx, {
        productId: mv.productId,
        warehouseId: mv.warehouseId,
        lotId: mv.lotId,
        qty: mv.qtyBase,
        type: "issue",
        // The NOTE, not the order: two loads against one order are two
        // documents, and a movement must name the one that caused it.
        ref: noteId,
        refType: "deliveryNote",
        branchId: (note.branchId as string) ?? null,
        movedAt: String(note.dispatchedAt ?? ctx.at),
      });
      cost += -result.valueDelta;
      // Recorded on the LINE too, so the paperwork a person reads names the
      // batch — the half of a recall the receipt cannot answer.
      if (mv.lotId) {
        const line = shipped.find((l) => String(l.productId) === mv.productId && !l.lotId);
        if (line) await qe.patchComputed(ctx, NOTE_LINE, String(line.id), { lotId: mv.lotId });
      }
      if (result.valueDelta === 0 && !result.duplicate) {
        logger.warn("stock issued at zero cost — no receipts recorded for this product/warehouse", {
          deliveryNote: String(note.number ?? noteId),
          productId: mv.productId,
          warehouseId: mv.warehouseId,
        });
      }
    }
  });

  if (note.orderId) await reconcileOrder(ctx, String(note.orderId));
  logger.info("delivery dispatched", { noteId, lines: shipped.length });
  return round2(cost);
}

/**
 * Void a dispatched delivery: the load came back, or it was raised in error.
 *
 * Reverses at the value that LEFT, read back from the movements themselves —
 * not at today's average. Anything else leaves Inventory a few lira away from
 * where it started once other receipts have blended into the average, and a void
 * whose only job is to undo a post must undo it exactly. This is the same rule
 * `reverseInvoiceGL` follows.
 *
 * The order's shipped quantities are rolled back and the hold is restored: the
 * goods are promised again, and leaving them unheld would let somebody else sell
 * what this order is still waiting for.
 *
 * A draft note has no movements, so voiding one is a no-op here.
 *
 * Returns the value put back, for the GL entry that reverses the dispatch.
 */
export async function voidDelivery(ctx: RequestContext, noteId: string): Promise<number> {
  const qe = await getQueryEngine();
  const note = await qe.get(ctx, NOTE, noteId);
  const issued = await qe.listComplete(ctx, "stockMovement", {
    filters: [
      { field: "ref", op: "eq", value: noteId },
      { field: "refType", op: "eq", value: "deliveryNote" },
      { field: "type", op: "eq", value: "issue" },
    ],
  });
  if (issued.length === 0) return 0; // never dispatched — nothing to take back

  const inventory = await getInventoryService();
  const lines = await qe.listComplete(ctx, NOTE_LINE, {
    filters: [{ field: "noteId", op: "eq", value: noteId }],
  });
  let restored = 0;

  await qe.runInTransaction(async () => {
    for (const mv of [...issued].sort((a, b) => String(a.productId).localeCompare(String(b.productId)))) {
      const qty = Math.abs(Number(mv.qty ?? 0));
      if (qty <= 0) continue;
      const result = await inventory.writeMovement(ctx, {
        productId: String(mv.productId),
        warehouseId: String(mv.warehouseId),
        qty,
        type: "receipt",
        // The exact unit value that left. `writeMovement` would otherwise apply
        // the current average, and the difference is value invented or lost.
        unitCost: round4(Math.abs(Number(mv.value ?? 0)) / qty),
        // The same `ref`, distinguished by `type`. `writeMovement`'s idempotency
        // key includes the type, so the reversal cannot collide with the issue
        // it undoes — and the ledger still filters cleanly by the note that
        // caused both rows.
        ref: noteId,
        refType: "deliveryNote",
        branchId: (note.branchId as string) ?? null,
        movedAt: ctx.at,
      });
      restored += result.valueDelta;
    }

    for (const line of lines) {
      if (!line.orderLineId) continue;
      const qtyBase = Number(line.qtyBase ?? line.qty ?? 0);
      if (qtyBase <= 0) continue;
      const orderLine = await qe.get(ctx, ORDER_LINE, String(line.orderLineId));
      await qe.patchComputed(ctx, ORDER_LINE, String(line.orderLineId), {
        // Floored: a delivery voided twice must not drive the shipped figure
        // negative, which would make the line look over-ordered.
        qtyShipped: Math.max(0, round4(Number(orderLine.qtyShipped ?? 0) - qtyBase)),
      });
      // Hold the goods again — the order still owes them.
      const due = round4(outstandingOf(orderLine) + qtyBase);
      if (due > 1e-9 && line.productId) {
        await reserve(ctx, {
          productId: String(line.productId),
          warehouseId: String(note.warehouseId),
          qty: due,
          refType: "salesOrderLine",
          refId: String(line.orderLineId),
          branchId: (note.branchId as string) ?? null,
        });
      }
    }
  });

  if (note.orderId) await reconcileOrder(ctx, String(note.orderId));
  logger.info("delivery voided", { noteId, movements: issued.length });
  return round2(restored);
}

/**
 * Move the order's status to match what has actually shipped.
 *
 * Derived from the lines rather than set by the caller: a status somebody types
 * and a fulfilment somebody ships drift apart, and the lines are the ones the
 * warehouse acts on.
 */
export async function reconcileOrder(ctx: RequestContext, orderId: string): Promise<string> {
  const qe = await getQueryEngine();
  const lines = await orderLines(ctx, orderId);
  const shippable = lines.filter((l) => l.productId);
  if (shippable.length === 0) return String((await qe.get(ctx, ORDER, orderId)).status);

  const anyShipped = shippable.some((l) => Number(l.qtyShipped ?? 0) > 0);
  const allShipped = shippable.every((l) => outstandingOf(l) <= 1e-9);
  const status = allShipped ? "shipped" : anyShipped ? "partial" : "confirmed";

  const order = await qe.get(ctx, ORDER, orderId);
  // Never reopen a cancelled order: it was cancelled deliberately, and a stray
  // delivery against it is a mistake to surface rather than to absorb.
  if (String(order.status) === "cancelled") return "cancelled";
  if (String(order.status) !== status) await qe.patchComputed(ctx, ORDER, orderId, { status });
  return status;
}

/**
 * Turn a quote into an order — the link the chain was missing.
 *
 * Copies the lines as agreed, including their units and discounts, so what was
 * quoted is what is ordered. The order is a draft: confirming it is a separate,
 * deliberate act, because that is what holds the stock.
 */
export async function convertQuoteToOrder(ctx: RequestContext, quoteId: string): Promise<string> {
  const finance = await getFinanceService();
  const { doc: quote, lines } = await finance.getDocument(ctx, "quote", "quoteLine", "quoteId", quoteId);

  const order = await createOrder(
    ctx,
    {
      accountId: quote.accountId,
      quoteId,
      currencyCode: quote.currencyCode,
      branchId: quote.branchId ?? null,
      dealerId: quote.dealerId ?? null,
      orderDate: ctx.at.slice(0, 10),
      discountRate: Number(quote.discountRate ?? 0),
      discountAmount: Number(quote.discountAmount ?? 0),
    },
    lines.map((l) => ({
      productId: (l.productId as string) ?? null,
      description: String(l.description),
      qty: Number(l.qty),
      uomId: (l.uomId as string) ?? null,
      unitPrice: Number(l.unitPrice),
      taxRate: Number(l.taxRate),
      discountRate: Number(l.discountRate ?? 0),
      discountAmount: Number(l.discountAmount ?? 0),
    })),
  );
  return String(order.id);
}

/**
 * Invoice a dispatched delivery — the last link, and the one that closes the
 * chain `deal → quote → order → delivery → invoice → payment`.
 *
 * Invoices what actually LEFT, line by line off the note, rather than what was
 * ordered. That is the whole reason the two documents are separate: a customer
 * who ordered a hundred and received sixty is billed for sixty, and the
 * remaining forty stay on the order waiting for a second load.
 *
 * The note records which invoice took it, and `postInvoiceCOGS` reads that link
 * to leave the stock alone — the goods left at dispatch and were costed then.
 */
export async function convertDeliveryToInvoice(ctx: RequestContext, noteId: string): Promise<string> {
  const qe = await getQueryEngine();
  const finance = await getFinanceService();
  const note = await qe.get(ctx, NOTE, noteId);

  if (String(note.status) !== "posted") {
    throw new ConflictError("only a dispatched delivery note can be invoiced");
  }
  if (note.invoiceId) return String(note.invoiceId); // already invoiced — hand back the same one

  const lines = await qe.listComplete(ctx, NOTE_LINE, {
    filters: [{ field: "noteId", op: "eq", value: noteId }],
  });
  const order = note.orderId ? await qe.get(ctx, ORDER, String(note.orderId)).catch(() => null) : null;
  const issueDate = ctx.at.slice(0, 10);

  const invoice = await finance.createDocument(ctx, "invoice", "INV", {
    accountId: note.accountId,
    currencyCode: order?.currencyCode ?? BASE_CURRENCY,
    branchId: note.branchId ?? null,
    dealerId: order?.dealerId ?? null,
    issueDate,
    dueDate: issueDate,
    status: "draft",
    notes: note.notes ?? null,
    // The header discount travels with the order it came from; without it a
    // document-level discount agreed on the order silently disappears when the
    // load is billed.
    discountRate: Number(order?.discountRate ?? 0),
    discountAmount: Number(order?.discountAmount ?? 0),
  });

  await finance.replaceLines(
    ctx,
    "invoice",
    "invoiceLine",
    "invoiceId",
    invoice.id,
    lines.map((l) => ({
      productId: (l.productId as string) ?? null,
      description: String(l.description),
      qty: Number(l.qty),
      uomId: (l.uomId as string) ?? null,
      unitPrice: Number(l.unitPrice),
      taxRate: Number(l.taxRate),
      discountRate: Number(l.discountRate ?? 0),
      discountAmount: Number(l.discountAmount ?? 0),
    })),
  );

  // Written last, so a failure part-way through leaves an unlinked draft
  // invoice somebody can delete — rather than a note pointing at an invoice
  // that has no lines, which would suppress the COGS posting for goods that
  // were never billed.
  await qe.patchComputed(ctx, NOTE, noteId, { invoiceId: String(invoice.id) });
  return String(invoice.id);
}
