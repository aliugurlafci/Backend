/**
 * Purchasing service — purchase orders (reusing the finance document machinery
 * for header/line totals) and goods receipts (which post to the stock ledger).
 * GRN posting is synchronous + idempotent: re-posting writes no new movements.
 */
import type { EntityRecord } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import { systemContext } from "@/lib/context/resolver";
import { BadRequestError, ConflictError, ForbiddenError } from "@/lib/enforcement";
import { newId } from "@/lib/core/ids";
import { lineQtyInBase } from "@/lib/inventory/uom";
import { eventBus } from "@/lib/workflow/event-bus";
import { getQueryEngine } from "@/lib/data/store";
import type { QueryEngine } from "@/lib/data/query-engine";
import { numberSequence, NumberSequence } from "@/lib/finance/number-sequence";
import { getFinanceService, type FinanceService, type LineInput, type DocumentResult } from "@/lib/finance/service";
import { getInventoryService, type InventoryService } from "@/lib/inventory/service";
import { collapseMovementLines } from "@/lib/inventory/movement-lines";
import { recordPurchase } from "./supplier-price";
import { ensureLot } from "@/lib/inventory/lots";
import { postGoodsReceiptGL } from "@/lib/accounting/postings";

export interface GrnLineInput {
  productId: string;
  qty: number;
  /** Omitted means "at the agreed price" — defaulted from the PO line received. */
  unitCost?: number;
  warehouseId?: string | null;
  /**
   * The PO line this satisfies.
   *
   * Optional, because callers that predate it still work — but supplying it is
   * what makes an order with the same product on two lines receivable correctly.
   */
  poLineId?: string | null;
  /**
   * The batch that arrived, as printed on the box.
   *
   * Required for a product that tracks lots — `applyGRN` refuses without it,
   * because stock received against no lot lands in a balance that no lot holds
   * and is invisible to both picking and recall.
   */
  lotNumber?: string | null;
  expiryDate?: string | null;
  manufacturedDate?: string | null;
  serialNumber?: string | null;
}

export class PurchasingService {
  constructor(
    private readonly qe: QueryEngine,
    private readonly finance: FinanceService,
    private readonly inventory: InventoryService,
    private readonly seq: NumberSequence,
  ) {}

  private sys(ctx: RequestContext): RequestContext {
    return systemContext(ctx.tenantId, ctx.orgId, { userId: ctx.userId, displayName: ctx.displayName, email: ctx.email });
  }

  /**
   * Publish a domain event (notifications, automation, webhooks subscribe).
   *
   * Attaches the FULL entity record to the payload (entity = the part of the type
   * before the dot, id = payload.id) so automation `{{record.*}}` resolves the
   * same way it does for DomainService events — without these bespoke emits
   * shipping a thin `{id, …}` payload. Transient payload keys (number, ownerId,
   * reason, …) survive alongside `record`. Fetch failures (e.g. a just-deleted
   * row) leave the record absent rather than blocking the event.
   */
  private async emit(ctx: RequestContext, type: string, payload: Record<string, unknown>): Promise<void> {
    let record = payload.record;
    if (record == null && typeof payload.id === "string") {
      const entity = type.split(".")[0] ?? "";
      try {
        record = await this.qe.get(this.sys(ctx), entity, payload.id);
      } catch {
        /* row unreadable / gone — publish without a record (subscriber falls back to {id}) */
      }
    }
    await eventBus.publish({
      id: newId("evt"),
      type,
      at: ctx.at,
      tenantId: ctx.tenantId,
      orgId: ctx.orgId,
      actorId: ctx.userId,
      correlationId: ctx.correlationId,
      payload: record == null ? payload : { ...payload, record },
    });
  }

  // ---- Purchase orders ----

  async createPO(ctx: RequestContext, header: Record<string, unknown>, lines: LineInput[]): Promise<DocumentResult> {
    const po = await this.finance.createDocument(ctx, "purchaseOrder", "PO", header);
    if (lines.length) {
      await this.finance.replaceLines(ctx, "purchaseOrder", "purchaseOrderLine", "poId", po.id, lines);
    }
    return this.finance.getDocument(ctx, "purchaseOrder", "purchaseOrderLine", "poId", po.id);
  }

  async savePO(ctx: RequestContext, poId: string, header: Record<string, unknown> | undefined, lines: LineInput[]): Promise<DocumentResult> {
    return this.finance.saveDocument(ctx, "purchaseOrder", "purchaseOrderLine", "poId", poId, header, lines);
  }

  async getPO(ctx: RequestContext, poId: string): Promise<DocumentResult> {
    return this.finance.getDocument(ctx, "purchaseOrder", "purchaseOrderLine", "poId", poId);
  }

  // ---- PO approval workflow ----

  /** The direct supervisor (managerId / üst amir) of a user, or null if none. */
  private async supervisorOf(ctx: RequestContext, userId: string | null | undefined): Promise<string | null> {
    if (!userId) return null;
    try {
      const user = await this.qe.get(this.sys(ctx), "user", String(userId));
      const mgr = user.managerId ? String(user.managerId) : null;
      return mgr && mgr !== String(userId) ? mgr : null; // guard against self-reference
    } catch {
      return null; // user row missing (e.g. system/seed actor) → no supervisor
    }
  }

  /**
   * Submit a draft/rejected PO for approval. Routes to the creator's supervisor;
   * if the creator has no supervisor the PO is approved immediately.
   */
  async submitPO(ctx: RequestContext, poId: string): Promise<EntityRecord> {
    const po = await this.qe.get(ctx, "purchaseOrder", poId);
    const status = String(po.status);
    if (status !== "draft" && status !== "rejected") {
      throw new ConflictError(`only a draft purchase order can be submitted (status: ${status})`).withKey("err.poNotDraftSubmit", { status });
    }
    const lines = await this.qe.list(ctx, "purchaseOrderLine", { filters: [{ field: "poId", op: "eq", value: poId }], pageSize: 1 });
    if (lines.total === 0) throw new BadRequestError("add at least one line before submitting for approval");

    const creatorId = (po.ownerId as string) ?? (po.createdBy) ?? ctx.userId;
    const approverId = await this.supervisorOf(ctx, creatorId);
    const number = po.number ?? null;
    if (!approverId) {
      // No supervisor → auto-approve.
      const updated = await this.qe.patchComputed(ctx, "purchaseOrder", poId, {
        status: "approved", approverId: creatorId ?? null, approvedAt: ctx.at, rejectionReason: null,
      });
      await this.emit(ctx, "purchaseOrder.approved", { id: poId, number, ownerId: creatorId, auto: true });
      return updated;
    }
    const updated = await this.qe.patchComputed(ctx, "purchaseOrder", poId, {
      status: "pending", approverId, approvedAt: null, rejectionReason: null,
    });
    await this.emit(ctx, "purchaseOrder.submitted", { id: poId, number, approverId, ownerId: creatorId });
    return updated;
  }

  /** Approve or reject a pending PO. Only the routed approver or an admin may act. */
  async decidePO(ctx: RequestContext, poId: string, decision: "approve" | "reject", reason?: string | null): Promise<EntityRecord> {
    const po = await this.qe.get(ctx, "purchaseOrder", poId);
    if (String(po.status) !== "pending") {
      throw new ConflictError(`only a pending purchase order can be ${decision === "approve" ? "approved" : "rejected"}`).withKey(decision === "approve" ? "err.poNotPendingApprove" : "err.poNotPendingReject");
    }
    const isApprover = po.approverId != null && String(po.approverId) === String(ctx.userId);
    const isAdmin = ctx.roles.includes("admin");
    if (!isApprover && !isAdmin) {
      throw new ForbiddenError("only the assigned approver (or an admin) may decide this purchase order");
    }
    const ownerId = (po.ownerId as string) ?? (po.createdBy) ?? null;
    const number = po.number ?? null;
    if (decision === "approve") {
      const updated = await this.qe.patchComputed(ctx, "purchaseOrder", poId, {
        status: "approved", approverId: ctx.userId, approvedAt: ctx.at, rejectionReason: null,
      });
      await this.emit(ctx, "purchaseOrder.approved", { id: poId, number, ownerId });
      return updated;
    }
    const updated = await this.qe.patchComputed(ctx, "purchaseOrder", poId, {
      status: "rejected", approvedAt: null, rejectionReason: reason ?? null,
    });
    await this.emit(ctx, "purchaseOrder.rejected", { id: poId, number, ownerId, reason: reason ?? null });
    return updated;
  }

  /** A PO can only receive goods once approved and not yet fully received. */
  private isReceivable(status: string): boolean {
    return status === "approved" || status === "partial";
  }

  // ---- Goods receipts ----

  /**
   * Create a goods receipt against an APPROVED purchase order. Only the PO's own
   * line items may be received and only up to each line's outstanding quantity —
   * there is no free-form receiving (every receipt must trace to an approved PO).
   */
  async createGRN(ctx: RequestContext, header: Record<string, unknown>, lines: GrnLineInput[]): Promise<DocumentResult> {
    const poId = header.poId ? String(header.poId) : null;
    if (!poId) throw new BadRequestError("a goods receipt must reference an approved purchase order");

    const po = await this.qe.get(ctx, "purchaseOrder", poId);
    if (!this.isReceivable(String(po.status))) {
      throw new ConflictError(`purchase order ${String(po.number ?? poId)} is not approved for receiving (status: ${String(po.status)})`).withKey("err.poNotApprovedReceive", { number: String(po.number ?? poId), status: String(po.status) });
    }

    // Outstanding quantity PER PO LINE, not per product.
    //
    // Keying by product merged two lines for the same item into one bucket, so
    // an order with "10 @ 60" and "5 @ 65" — a price change, or two batches —
    // lost which was which. The second line's price also overwrote the first as
    // the default cost, so receiving the first ten was silently valued at 65.
    const unordered = await this.qe.listComplete(ctx, "purchaseOrderLine", { filters: [{ field: "poId", op: "eq", value: poId }] });
    // SORTED, because the fallback below depends on "oldest first" and an
    // unsorted read returns whatever order the database chose. The comment used
    // to claim the order without enforcing it, and the fallback duly picked the
    // wrong line.
    const poLines = [...unordered].sort((a, b) => Number(a.id) - Number(b.id));
    const byLine = new Map(poLines.map((pl) => [String(pl.id), pl]));
    const outstandingByLine = new Map<string, number>();
    for (const pl of poLines) {
      outstandingByLine.set(String(pl.id), Number(pl.qty) - Number(pl.qtyReceived ?? 0));
    }

    const validLines = lines.filter((l) => l.productId && Number(l.qty) > 0);
    if (!validLines.length) throw new BadRequestError("add at least one line to receive");

    /**
     * Which PO line a receipt line satisfies.
     *
     * An explicit `poLineId` is used as given. Without one — a caller written
     * before this existed, or a scanner that only knows the barcode — the oldest
     * line for that product with quantity still outstanding is taken. Oldest
     * first because a PO's lines are in the order they were negotiated, and
     * filling the earliest commitment first is what a buyer would do by hand.
     */
    const resolveLine = (l: GrnLineInput): string => {
      if (l.poLineId && byLine.has(String(l.poLineId))) return String(l.poLineId);
      const match = poLines.find(
        (pl) => String(pl.productId) === String(l.productId) && (outstandingByLine.get(String(pl.id)) ?? 0) > 1e-9,
      );
      if (!match) {
        throw new ConflictError(
          `product is not on purchase order ${String(po.number ?? poId)}, or has nothing left to receive`,
        ).withKey("err.productNotOnPo", { number: String(po.number ?? poId) });
      }
      return String(match.id);
    };

    // Resolved once and reused, so validation and the write agree on which line
    // each receipt row belongs to.
    const assigned = validLines.map((l) => ({ line: l, poLineId: resolveLine(l) }));

    // Consumed as we go: two receipt rows for the same product must not both be
    // checked against the same untouched outstanding quantity.
    const remaining = new Map(outstandingByLine);
    for (const { line: l, poLineId: plId } of assigned) {
      const rem = remaining.get(plId) ?? 0;
      if (Number(l.qty) > rem + 1e-9) {
        throw new ConflictError(`received quantity (${l.qty}) exceeds the outstanding ${rem} for this PO line`).withKey("err.receiveExceeds", { qty: l.qty, remaining: rem });
      }
      remaining.set(plId, rem - Number(l.qty));
    }

    // Default header fields from the PO when the caller omits them.
    const number = await this.seq.next(ctx.tenantId, "GRN");
    const grn = await this.qe.createWithComputed(
      ctx,
      "goodsReceipt",
      {
        status: "draft",
        ...header,
        poId,
        supplierId: header.supplierId ?? po.supplierId ?? null,
        warehouseId: header.warehouseId ?? po.warehouseId,
        branchId: header.branchId ?? po.branchId ?? null,
      },
      { number },
    );
    for (const { line: l, poLineId: plId } of assigned) {
      const poLine = byLine.get(plId);
      // The receipt inherits the ORDER's unit: two cases ordered are received as
      // two cases, and the quantity on the receipt means what it meant on the
      // order. Defaulting to the base unit instead would silently turn a receipt
      // of two cases into two pieces.
      const uomId = poLine?.uomId ? String(poLine.uomId) : null;
      const qtyBase = l.productId
        ? await lineQtyInBase(ctx, String(l.productId), Number(l.qty), uomId)
        : Number(l.qty);
      await this.qe.createWithComputed(
        ctx,
        "goodsReceiptLine",
        {
          grnId: grn.id,
          poLineId: plId,
          productId: l.productId,
          lotId: l.lotNumber
            ? String(
                (
                  await ensureLot(ctx, {
                    productId: String(l.productId),
                    lotNumber: String(l.lotNumber),
                    expiryDate: l.expiryDate ?? null,
                    manufacturedDate: l.manufacturedDate ?? null,
                    serialNumber: l.serialNumber ?? null,
                    supplierId: (grn.supplierId as string) ?? (po.supplierId as string) ?? null,
                    grnId: String(grn.id),
                  })
                ).id,
              )
            : null,
          // The cost defaults from THIS line's price, not from whichever line for
          // the product happened to be written to the map last.
          unitCost: l.unitCost ?? Number(poLine?.unitPrice ?? 0),
          qty: l.qty,
          uomId,
          warehouseId: l.warehouseId ?? grn.warehouseId ?? null,
        },
        { qtyBase },
      );
    }
    return this.getGRN(ctx, grn.id);
  }

  async getGRN(ctx: RequestContext, grnId: string): Promise<DocumentResult> {
    const doc = await this.qe.get(ctx, "goodsReceipt", grnId);
    const lines = await this.qe.listComplete(ctx, "goodsReceiptLine", {
      filters: [{ field: "grnId", op: "eq", value: grnId }],
    });
    return { doc, lines };
  }

  /**
   * Post a goods receipt: append a stock receipt movement per line (idempotent on
   * the GRN id), then reconcile the linked PO's received quantities + status.
   */
  async postGRN(ctx: RequestContext, grnId: string): Promise<EntityRecord> {
    const sys = this.sys(ctx);
    const grn = await this.qe.get(sys, "goodsReceipt", grnId);
    if (grn.status === "posted") return grn; // already posted — no-op
    await this.applyGRN(ctx, grnId);
    return this.qe.get(sys, "goodsReceipt", grnId);
  }

  /**
   * The side effects of posting a receipt: stock movements, the GL entry, and
   * the PO reconciliation.
   *
   * Split from `postGRN` because the two entry points reach it at different
   * moments. The bespoke route calls `postGRN`, which checks the status and then
   * sets it. The generic lifecycle endpoint sets the status FIRST and then emits
   * `goodsReceipt.post` — at which point `postGRN` sees "posted" and returns as a
   * no-op, so the receipt flipped state with no stock movement, no
   * Inventory/GR-IR entry, and a purchase order still showing nothing received.
   *
   * Idempotent on the GRN id through the stock ledger and the GL, so calling it
   * twice is safe; the status check above is an optimisation, not the guarantee.
   */
  async applyGRN(ctx: RequestContext, grnId: string): Promise<EntityRecord> {
    const sys = this.sys(ctx);
    const { doc: grn, lines } = await this.getGRN(sys, grnId);

    const headerWarehouse = grn.warehouseId as string;
    const branchId = (grn.branchId as string) ?? null;
    // One movement per product per warehouse, with the costs weighted and a
    // stable lock order falling out of it. Receiving the same product against
    // two PO lines at different prices is ordinary, and `writeMovement` is
    // idempotent on (ref, refType, product, warehouse, type) — so the second
    // line used to come back as a duplicate and its quantity never reached the
    // shelf, while the GR/IR accrual counted both. See `collapseMovementLines`.
    //
    // Base units. Receiving three cases puts thirty-six pieces on the shelf, and
    // the ledger only ever counts pieces.
    // A lot-tracked product must name its batch. Receiving without one puts the
    // stock in a balance no lot holds — invisible to picking and to a recall,
    // which is worse than refusing the receipt.
    const trackedIds = [...new Set(lines.filter((l) => l.productId).map((l) => String(l.productId)))];
    const tracked = trackedIds.length
      ? await this.qe.listByIds(sys, "product", trackedIds)
      : [];
    const tracksLots = new Set(tracked.filter((p) => p.trackLots).map((p) => String(p.id)));
    for (const line of lines) {
      if (line.productId && tracksLots.has(String(line.productId)) && !line.lotId) {
        throw new BadRequestError(
          `this product is tracked by lot — record the batch number before posting receipt ${String(grn.number ?? grnId)}`,
        ).withKey("err.lotRequiredOnReceipt", { number: String(grn.number ?? grnId) });
      }
    }

    // Collapsed per (product, warehouse, LOT). Two lines of the same product
    // from different batches are different stock: they have different dates,
    // different traceability and their own balances.
    const ordered = collapseMovementLines(
      lines.map((line) => ({
        productId: String(line.productId),
        warehouseId: (line.warehouseId as string) || headerWarehouse,
        lotId: line.lotId ? String(line.lotId) : null,
        qtyBase: Number(line.qtyBase ?? line.qty),
        unitCost: Number(line.unitCost ?? 0),
      })),
    );
    const movements = [];
    for (const line of ordered) {
      movements.push(
        await this.inventory.writeMovement(sys, {
          productId: line.productId,
          warehouseId: line.warehouseId,
          lotId: line.lotId,
          qty: line.qtyBase,
          type: "receipt",
          unitCost: line.unitCost,
          ref: grnId,
          refType: "goodsReceipt",
          branchId,
          movedAt: ctx.at,
        }),
      );
    }

    // GL: Dr Inventory, Cr GR/IR clearing (idempotent on the GRN id). Post the
    // value the ledger actually added, not a second computation of it.
    await postGoodsReceiptGL(sys, grn, movements);

    // What this supplier actually charged, recorded against the agreement. The
    // receipt writes it; nobody types it. Uncollapsed lines deliberately — a
    // per-line price is what the supplier billed, and the collapsed weighted
    // average is an artefact of how the ledger stores movements.
    const supplierId = grn.supplierId ? String(grn.supplierId) : "";
    if (supplierId) {
      await recordPurchase(
        sys,
        supplierId,
        lines
          .filter((l) => l.productId && Number(l.unitCost ?? 0) > 0)
          .map((l) => ({
            productId: String(l.productId),
            unitCost: Number(l.unitCost ?? 0),
            uomId: (l.uomId as string) ?? null,
          })),
        String(grn.receiptDate ?? ctx.at),
      );
    }

    // Set here for the bespoke route's benefit; the lifecycle path has already
    // done it, and writing the same value again is a no-op.
    const posted = await this.qe.patchComputed(sys, "goodsReceipt", grnId, { status: "posted" });
    if (grn.poId) {
      await this.reconcilePO(sys, grn.poId as string);
      // Notify the PO owner that their approved order has arrived.
      const po = await this.qe.get(sys, "purchaseOrder", String(grn.poId)).catch(() => null);
      await this.emit(ctx, "goodsReceipt.posted", {
        id: grnId,
        number: grn.number ?? null,
        poId: grn.poId,
        poNumber: po?.number ?? null,
        poOwnerId: (po?.ownerId) ?? null,
      });
    }
    return posted;
  }

  /** Recompute each PO line's qtyReceived from posted GRNs and set PO status. */
  private async reconcilePO(ctx: RequestContext, poId: string): Promise<void> {
    // Each of these must be complete: `qtyReceived` is recomputed from scratch,
    // so a missing GRN or line would under-report receipts and reopen a PO that
    // is actually fully received.
    const grns = await this.qe.listComplete(ctx, "goodsReceipt", {
      filters: [{ field: "poId", op: "eq", value: poId }],
    });
    const postedIds = grns.filter((g) => g.status === "posted").map((g) => g.id);

    // Attributed per PO LINE. Receipts written before `poLineId` existed carry
    // only a product, so those are collected separately and spread over that
    // product's lines afterwards — oldest first, the same rule `resolveLine`
    // uses, so an old receipt and a new one land the same way.
    const receivedByLine = new Map<string, number>();
    const legacyByProduct = new Map<string, number>();
    for (const gid of postedIds) {
      const gls = await this.qe.listComplete(ctx, "goodsReceiptLine", {
        filters: [{ field: "grnId", op: "eq", value: gid }],
      });
      for (const gl of gls) {
        const qty = Number(gl.qty);
        if (gl.poLineId) {
          const key = String(gl.poLineId);
          receivedByLine.set(key, (receivedByLine.get(key) ?? 0) + qty);
        } else {
          const pid = String(gl.productId);
          legacyByProduct.set(pid, (legacyByProduct.get(pid) ?? 0) + qty);
        }
      }
    }

    const poLines = await this.qe.listComplete(ctx, "purchaseOrderLine", {
      filters: [{ field: "poId", op: "eq", value: poId }],
    });
    let allReceived = poLines.length > 0;
    let anyReceived = false;
    for (const pl of poLines) {
      let received = receivedByLine.get(String(pl.id)) ?? 0;
      // Fill this line from the unattributed pool, up to what it ordered.
      const pid = String(pl.productId);
      const pool = legacyByProduct.get(pid) ?? 0;
      if (pool > 0) {
        const room = Math.max(0, Number(pl.qty) - received);
        const take = Math.min(pool, room);
        received += take;
        legacyByProduct.set(pid, pool - take);
      }
      await this.qe.patchComputed(ctx, "purchaseOrderLine", pl.id, { qtyReceived: received });
      if (received > 0) anyReceived = true;
      if (received < Number(pl.qty)) allReceived = false;
    }

    const status = allReceived ? "received" : anyReceived ? "partial" : null;
    if (status) await this.qe.patchComputed(ctx, "purchaseOrder", poId, { status });
  }
}

const globalRef = globalThis as unknown as { __aulaPurchasing?: PurchasingService };

export async function getPurchasingService(): Promise<PurchasingService> {
  const qe = await getQueryEngine();
  const [finance, inventory] = [await getFinanceService(), await getInventoryService()];
  globalRef.__aulaPurchasing ??= new PurchasingService(qe, finance, inventory, numberSequence);
  return globalRef.__aulaPurchasing;
}
