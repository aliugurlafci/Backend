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
import { eventBus } from "@/lib/workflow/event-bus";
import { getQueryEngine } from "@/lib/data/store";
import type { QueryEngine } from "@/lib/data/query-engine";
import { numberSequence, NumberSequence } from "@/lib/finance/number-sequence";
import { getFinanceService, type FinanceService, type LineInput, type DocumentResult } from "@/lib/finance/service";
import { getInventoryService, type InventoryService } from "@/lib/inventory/service";
import { postGoodsReceiptGL } from "@/lib/accounting/postings";

export interface GrnLineInput {
  productId: string;
  qty: number;
  unitCost: number;
  warehouseId?: string | null;
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

  /** Publish a domain event (notifications, automation, webhooks subscribe). */
  private async emit(ctx: RequestContext, type: string, payload: Record<string, unknown>): Promise<void> {
    await eventBus.publish({
      id: newId("evt"),
      type,
      at: ctx.at,
      tenantId: ctx.tenantId,
      orgId: ctx.orgId,
      actorId: ctx.userId,
      correlationId: ctx.correlationId,
      payload,
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
      throw new ConflictError(`only a draft purchase order can be submitted (status: ${status})`);
    }
    const lines = await this.qe.list(ctx, "purchaseOrderLine", { filters: [{ field: "poId", op: "eq", value: poId }], pageSize: 1 });
    if (lines.total === 0) throw new BadRequestError("add at least one line before submitting for approval");

    const creatorId = (po.ownerId as string) ?? (po.createdBy as string) ?? ctx.userId;
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
      throw new ConflictError(`only a pending purchase order can be ${decision === "approve" ? "approved" : "rejected"}`);
    }
    const isApprover = po.approverId != null && String(po.approverId) === String(ctx.userId);
    const isAdmin = ctx.roles.includes("admin");
    if (!isApprover && !isAdmin) {
      throw new ForbiddenError("only the assigned approver (or an admin) may decide this purchase order");
    }
    const ownerId = (po.ownerId as string) ?? (po.createdBy as string) ?? null;
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
      throw new ConflictError(`purchase order ${String(po.number ?? poId)} is not approved for receiving (status: ${String(po.status)})`);
    }

    // Outstanding quantity per PO product line (ordered − already received).
    const poLines = await this.qe.list(ctx, "purchaseOrderLine", { filters: [{ field: "poId", op: "eq", value: poId }], pageSize: 200 });
    const outstanding = new Map<string, number>();
    const poCost = new Map<string, number>();
    for (const pl of poLines.items) {
      const pid = String(pl.productId);
      outstanding.set(pid, (outstanding.get(pid) ?? 0) + (Number(pl.qty) - Number(pl.qtyReceived ?? 0)));
      poCost.set(pid, Number(pl.unitPrice ?? 0));
    }

    const validLines = lines.filter((l) => l.productId && Number(l.qty) > 0);
    if (!validLines.length) throw new BadRequestError("add at least one line to receive");
    for (const l of validLines) {
      const pid = String(l.productId);
      if (!outstanding.has(pid)) throw new ConflictError(`product is not on purchase order ${String(po.number ?? poId)}`);
      const rem = outstanding.get(pid) ?? 0;
      if (Number(l.qty) > rem + 1e-9) {
        throw new ConflictError(`received quantity (${l.qty}) exceeds the outstanding ${rem} for this PO line`);
      }
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
    for (const l of validLines) {
      await this.qe.create(ctx, "goodsReceiptLine", {
        grnId: grn.id,
        productId: l.productId,
        qty: l.qty,
        unitCost: l.unitCost ?? poCost.get(String(l.productId)) ?? 0,
        warehouseId: l.warehouseId ?? grn.warehouseId ?? null,
      });
    }
    return this.getGRN(ctx, grn.id);
  }

  async getGRN(ctx: RequestContext, grnId: string): Promise<DocumentResult> {
    const doc = await this.qe.get(ctx, "goodsReceipt", grnId);
    const lines = await this.qe.list(ctx, "goodsReceiptLine", {
      filters: [{ field: "grnId", op: "eq", value: grnId }],
      pageSize: 200,
    });
    return { doc, lines: lines.items };
  }

  /**
   * Post a goods receipt: append a stock receipt movement per line (idempotent on
   * the GRN id), then reconcile the linked PO's received quantities + status.
   */
  async postGRN(ctx: RequestContext, grnId: string): Promise<EntityRecord> {
    const sys = this.sys(ctx);
    const { doc: grn, lines } = await this.getGRN(sys, grnId);
    if (grn.status === "posted") return grn; // already posted — no-op

    const headerWarehouse = grn.warehouseId as string;
    const branchId = (grn.branchId as string) ?? null;
    for (const line of lines) {
      await this.inventory.writeMovement(sys, {
        productId: line.productId as string,
        warehouseId: (line.warehouseId as string) || headerWarehouse,
        qty: Number(line.qty),
        type: "receipt",
        unitCost: Number(line.unitCost ?? 0),
        ref: grnId,
        refType: "goodsReceipt",
        branchId,
        movedAt: ctx.at,
      });
    }

    // GL: Dr Inventory, Cr GR/IR clearing (idempotent on the GRN id).
    await postGoodsReceiptGL(
      sys,
      grn,
      lines.map((l) => ({ qty: Number(l.qty), unitCost: Number(l.unitCost ?? 0) })),
    );

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
        poOwnerId: (po?.ownerId as string) ?? null,
      });
    }
    return posted;
  }

  /** Recompute each PO line's qtyReceived from posted GRNs and set PO status. */
  private async reconcilePO(ctx: RequestContext, poId: string): Promise<void> {
    const grns = await this.qe.list(ctx, "goodsReceipt", {
      filters: [{ field: "poId", op: "eq", value: poId }],
      pageSize: 200,
    });
    const postedIds = grns.items.filter((g) => g.status === "posted").map((g) => g.id);

    const receivedByProduct = new Map<string, number>();
    for (const gid of postedIds) {
      const gls = await this.qe.list(ctx, "goodsReceiptLine", {
        filters: [{ field: "grnId", op: "eq", value: gid }],
        pageSize: 200,
      });
      for (const gl of gls.items) {
        const pid = String(gl.productId);
        receivedByProduct.set(pid, (receivedByProduct.get(pid) ?? 0) + Number(gl.qty));
      }
    }

    const poLines = await this.qe.list(ctx, "purchaseOrderLine", {
      filters: [{ field: "poId", op: "eq", value: poId }],
      pageSize: 200,
    });
    let allReceived = poLines.items.length > 0;
    let anyReceived = false;
    for (const pl of poLines.items) {
      const received = receivedByProduct.get(String(pl.productId)) ?? 0;
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
