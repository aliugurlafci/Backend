/**
 * Inventory service — appends to the immutable stockMovement ledger and derives
 * on-hand / valuation by aggregation. The ledger is the single source of truth;
 * there is no maintained per-product level row (avoids drift). Writes run under an
 * elevated system context (the ledger is a system-generated side effect) while
 * reads honour the caller's permissions.
 */
import type { EntityRecord, FieldValue } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import type { Filter } from "@/lib/data/query";
import { systemContext } from "@/lib/context/resolver";
import { getQueryEngine } from "@/lib/data/store";
import type { QueryEngine } from "@/lib/data/query-engine";

export type StockMovementType = "receipt" | "issue" | "transfer_out" | "transfer_in" | "adjustment";
export type StockRefType = "opening" | "goodsReceipt" | "invoice" | "salesOrder" | "salesReturn" | "stockTransfer" | "adjustment";

export interface MovementInput {
  productId: string;
  warehouseId: string;
  /** Signed: + receipt / transfer_in, − issue / transfer_out. */
  qty: number;
  type: StockMovementType;
  unitCost?: number;
  ref?: string | null;
  refType?: StockRefType | null;
  branchId?: string | null;
  movedAt?: string;
}

export interface OnHandRow {
  productId: string;
  warehouseId: string;
  onHand: number;
  value: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
export const stockKeyOf = (productId: string, warehouseId: string): string => `${productId}:${warehouseId}`;

export class InventoryService {
  constructor(private readonly qe: QueryEngine) {}

  /** Elevated context for system-generated ledger writes (keeps tenant + actor). */
  private sys(ctx: RequestContext): RequestContext {
    return systemContext(ctx.tenantId, ctx.orgId, { userId: ctx.userId, displayName: ctx.displayName, email: ctx.email });
  }

  /**
   * Append a signed stock movement. Idempotent on (ref, refType, product,
   * warehouse, type) so re-posting a document never double-counts.
   */
  async writeMovement(ctx: RequestContext, m: MovementInput): Promise<EntityRecord> {
    const sys = this.sys(ctx);
    if (m.ref && m.refType) {
      const existing = await this.qe.list(sys, "stockMovement", {
        filters: [
          { field: "ref", op: "eq", value: m.ref },
          { field: "refType", op: "eq", value: m.refType },
          { field: "productId", op: "eq", value: m.productId },
          { field: "warehouseId", op: "eq", value: m.warehouseId },
          { field: "type", op: "eq", value: m.type },
        ],
        pageSize: 1,
      });
      if (existing.total > 0) return existing.items[0]; // already posted — no-op
    }
    const unitCost = m.unitCost ?? 0;
    const computed: Record<string, FieldValue> = {
      value: round2(m.qty * unitCost),
      stockKey: stockKeyOf(m.productId, m.warehouseId),
    };
    return this.qe.createWithComputed(
      sys,
      "stockMovement",
      {
        productId: m.productId,
        warehouseId: m.warehouseId,
        qty: m.qty,
        type: m.type,
        unitCost,
        ref: m.ref ?? null,
        refType: m.refType ?? null,
        branchId: m.branchId ?? null,
        movedAt: m.movedAt ?? ctx.at,
      },
      computed,
    );
  }

  /** On-hand quantity for a product (optionally restricted to one warehouse). */
  async onHand(ctx: RequestContext, productId: string, warehouseId?: string): Promise<number> {
    const filters: Filter[] = [{ field: "productId", op: "eq", value: productId }];
    if (warehouseId) filters.push({ field: "warehouseId", op: "eq", value: warehouseId });
    const rows = await this.qe.aggregate(ctx, "stockMovement", { filters, measures: [{ op: "sum", field: "qty", as: "qty" }] });
    return round2(rows[0]?.measures.qty ?? 0);
  }

  /** Inventory valuation (sum of signed value), optionally for one warehouse. */
  async valuation(ctx: RequestContext, warehouseId?: string): Promise<number> {
    const filters: Filter[] = warehouseId ? [{ field: "warehouseId", op: "eq", value: warehouseId }] : [];
    const rows = await this.qe.aggregate(ctx, "stockMovement", { filters, measures: [{ op: "sum", field: "value", as: "value" }] });
    return round2(rows[0]?.measures.value ?? 0);
  }

  /** On-hand + value grouped by product+warehouse (via the stockKey composite). */
  async onHandByKey(ctx: RequestContext): Promise<OnHandRow[]> {
    const rows = await this.qe.aggregate(ctx, "stockMovement", {
      groupBy: "stockKey",
      measures: [
        { op: "sum", field: "qty", as: "qty" },
        { op: "sum", field: "value", as: "value" },
      ],
    });
    return rows
      .filter((r) => r.key)
      .map((r) => {
        const [productId, warehouseId] = String(r.key).split(":");
        return { productId, warehouseId, onHand: round2(r.measures.qty ?? 0), value: round2(r.measures.value ?? 0) };
      });
  }
}

const globalRef = globalThis as unknown as { __aulaInventory?: InventoryService };

export async function getInventoryService(): Promise<InventoryService> {
  const qe = await getQueryEngine();
  globalRef.__aulaInventory ??= new InventoryService(qe);
  return globalRef.__aulaInventory;
}
