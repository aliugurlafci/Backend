/**
 * Purchasing service — purchase orders (reusing the finance document machinery
 * for header/line totals) and goods receipts (which post to the stock ledger).
 * GRN posting is synchronous + idempotent: re-posting writes no new movements.
 */
import type { EntityRecord } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import { systemContext } from "@/lib/context/resolver";
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

  // ---- Goods receipts ----

  async createGRN(ctx: RequestContext, header: Record<string, unknown>, lines: GrnLineInput[]): Promise<DocumentResult> {
    const number = await this.seq.next(ctx.tenantId, "GRN");
    const grn = await this.qe.createWithComputed(ctx, "goodsReceipt", { status: "draft", ...header }, { number });
    for (const l of lines) {
      await this.qe.create(ctx, "goodsReceiptLine", {
        grnId: grn.id,
        productId: l.productId,
        qty: l.qty,
        unitCost: l.unitCost,
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
    if (grn.poId) await this.reconcilePO(sys, grn.poId as string);
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
