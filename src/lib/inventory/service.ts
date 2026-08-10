/**
 * Inventory service — the stock ledger and the balances derived from it.
 *
 * `stockMovement` stays the immutable record of what happened. Alongside it,
 * `stockBalance` carries the running (qty, value) per product × warehouse,
 * written in the *same transaction* as every movement. Two things depend on that
 * row existing:
 *
 *  - **Cost.** An issue costs the moving weighted average, which is a property
 *    of the balance at that instant. Costing arithmetic lives in `./costing` as
 *    pure functions so the live path and the reconcile/replay path cannot drift.
 *  - **Concurrency.** The old guard aggregated `SUM(qty)` and then inserted,
 *    with nothing to serialise two callers — both saw one unit left and both
 *    sold it. Locking the balance row is what makes the guard hold.
 *
 * `writeMovement` returns the value it actually applied so the GL posts that
 * exact number; computing cost twice is how the ledger and the accounts came to
 * disagree. Writes run under an elevated system context (the ledger is a
 * system-generated side effect); reads honour the caller's permissions.
 */
import type { EntityRecord, FieldValue } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import type { Filter } from "@/lib/data/query";
import { systemContext } from "@/lib/context/resolver";
import { env } from "@/lib/config/env";
import { BadRequestError, ConflictError } from "@/lib/enforcement/errors";
import { getQueryEngine } from "@/lib/data/store";
import type { QueryEngine } from "@/lib/data/query-engine";
import { applyInbound, applyOutbound, avgCostOf, round2, type BalanceState } from "./costing";

export type StockMovementType = "receipt" | "issue" | "transfer_out" | "transfer_in" | "adjustment";
export type StockRefType =
  | "opening"
  | "goodsReceipt"
  | "invoice"
  | "salesOrder"
  // The DELIVERY NOTE, not the order: an order shipped in two loads is two
  // notes, and a movement must name the document that actually moved the goods.
  | "deliveryNote"
  | "salesReturn"
  // Goods going back to a supplier — alım iadesi.
  | "purchaseReturn"
  | "stockTransfer"
  // Freight, duty and insurance added to what the goods cost — value with no
  // quantity behind it. See `purchasing/landed-cost`.
  | "landedCost"
  | "adjustment";

/** Movement types whose quantity may only go one way. `adjustment` is signed. */
const INBOUND_TYPES = new Set(["receipt", "transfer_in"]);
const OUTBOUND_TYPES = new Set(["issue", "transfer_out"]);

function assertSignMatchesType(m: { type: string; qty: number }): void {
  if (INBOUND_TYPES.has(m.type) && m.qty < 0) {
    throw new BadRequestError(`a ${m.type} movement cannot have a negative quantity (${m.qty})`).withKey("err.movementNegativeQty", { type: m.type, qty: m.qty });
  }
  if (OUTBOUND_TYPES.has(m.type) && m.qty > 0) {
    throw new BadRequestError(`an ${m.type} movement must have a negative quantity (got ${m.qty})`).withKey("err.movementMustBeNegative", { type: m.type, qty: m.qty });
  }
}

export interface MovementInput {
  productId: string;
  warehouseId: string;
  /** Signed: + receipt / transfer_in, − issue / transfer_out. */
  qty: number;
  /**
   * Cost per unit for an INBOUND movement (receipt, transfer-in, positive
   * adjustment). Ignored for outbound movements, whose cost is the balance's
   * moving average — passing one there would reintroduce the drift this design
   * removes. Defaults to the current average when omitted on an inbound move.
   */
  unitCost?: number;
  type: StockMovementType;
  /**
   * Which lot moved, for a product that tracks them.
   *
   * It is part of the balance's identity, so a movement without one against a
   * lot-tracked product would write to a row that holds no lot's stock. Callers
   * that issue from a tracked product split their quantity across lots first —
   * see `inventory/lots`.
   */
  lotId?: string | null;
  ref?: string | null;
  refType?: StockRefType | null;
  branchId?: string | null;
  movedAt?: string;
}

/**
 * What a movement actually did.
 *
 * `valueDelta` is the authoritative number: post it to the GL rather than
 * recomputing `qty × cost`, so the stock ledger and the accounts cannot diverge.
 */
export interface MovementResult {
  movement: EntityRecord;
  /** Cost per unit applied — the average for an issue, the given cost for a receipt. */
  appliedUnitCost: number;
  /** Signed change in inventory value. */
  valueDelta: number;
  onHandAfter: number;
  /** True when idempotency short-circuited; the stored values are returned unchanged. */
  duplicate: boolean;
}

export interface OnHandRow {
  productId: string;
  warehouseId: string;
  onHand: number;
  /**
   * Held for documents that have not shipped.
   *
   * Reported beside the on-hand figure because the two are always read
   * together and the row already carries both — asking "how much is free"
   * should not need a second query, and a caller that forgets to make it
   * quietly plans against stock somebody has already been promised.
   */
  reserved: number;
  value: number;
  avgCost: number;
}

/**
 * The identity of a balance row.
 *
 * Two parts for an ordinary product, three when the goods are tracked by lot.
 * The two-part form is deliberately unchanged: every balance written before lots
 * existed keeps its key, so nothing has to be migrated and no path that does not
 * care about lots has to learn about them.
 */
export const stockKeyOf = (productId: string, warehouseId: string, lotId?: string | null): string =>
  lotId ? `${productId}:${warehouseId}:${lotId}` : `${productId}:${warehouseId}`;

export class InventoryService {
  constructor(private readonly qe: QueryEngine) {}

  /** Elevated context for system-generated ledger writes (keeps tenant + actor). */
  private sys(ctx: RequestContext): RequestContext {
    return systemContext(ctx.tenantId, ctx.orgId, { userId: ctx.userId, displayName: ctx.displayName, email: ctx.email });
  }

  /**
   * Read the balance row under an exclusive lock, creating it if absent.
   *
   * The lock is the whole point, and a plain read plus optimistic retry is NOT
   * an equivalent substitute: under MySQL's REPEATABLE READ the retry re-reads
   * the same snapshot inside the same transaction and spins until it exhausts
   * its attempts, then reports a version conflict instead of "insufficient
   * stock". `getForUpdate` performs a current read and locks the key range, so a
   * *missing* row is covered too and two callers cannot both insert it.
   */
  private async lockBalance(
    sys: RequestContext,
    productId: string,
    warehouseId: string,
    branchId: string | null,
    lotId: string | null = null,
  ): Promise<EntityRecord> {
    const stockKey = stockKeyOf(productId, warehouseId, lotId);
    const find = () =>
      this.qe.getForUpdate(sys, "stockBalance", [{ field: "stockKey", op: "eq", value: stockKey }]);

    const existing = await find();
    if (existing) return existing;

    try {
      return await this.qe.createWithComputed(
        sys,
        "stockBalance",
        { productId, warehouseId, branchId, lotId, qty: 0, value: 0, lastMovedAt: null },
        { stockKey, avgCost: 0 },
      );
    } catch {
      // Lost the race to create it (the unique index on stockKey rejected us) —
      // the winner's row is committed, so re-read it under the lock.
      const won = await find();
      if (won) return won;
      throw new ConflictError(`could not acquire stock balance for ${stockKey}`).withKey("err.balanceLockFailed", { key: stockKey });
    }
  }

  /**
   * Append a signed stock movement and update the balance atomically.
   *
   * Idempotent on (ref, refType, product, warehouse, type): re-posting a
   * document returns the stored movement and its stored value, never a
   * recomputed one, so a retry cannot post a different number to the GL than the
   * original did.
   */
  async writeMovement(ctx: RequestContext, m: MovementInput): Promise<MovementResult> {
    const sys = this.sys(ctx);

    return this.qe.runInTransaction(async () => {
      if (m.ref && m.refType) {
        const existing = await this.qe.list(sys, "stockMovement", {
          filters: [
            { field: "ref", op: "eq", value: m.ref },
            { field: "refType", op: "eq", value: m.refType },
            { field: "productId", op: "eq", value: m.productId },
            { field: "warehouseId", op: "eq", value: m.warehouseId },
            { field: "type", op: "eq", value: m.type },
            // The LOT is part of the key. A document that ships fifty units out
            // of three lots writes three movements for the same product and
            // warehouse, and without the lot the second and third would come
            // back as duplicates of the first — two thirds of the goods leaving
            // the building unrecorded.
            { field: "lotId", op: "eq", value: m.lotId ?? null },
          ],
          pageSize: 1,
        });
        const prior = existing.items[0];
        if (prior) {
          return {
            movement: prior,
            appliedUnitCost: Number(prior.unitCost ?? 0),
            valueDelta: Number(prior.value ?? 0),
            onHandAfter: await this.onHand(sys, m.productId, m.warehouseId),
            duplicate: true,
          };
        }
      }

      // The SIGN drives the arithmetic below; `type` is only a label on the
      // resulting row. So a caller that passes `type: "issue"` with a positive
      // quantity increases stock and files the row as an issue — a ledger where
      // a line says "issue" and the value went up, which reconciliation cannot
      // catch because the balance and the movement still agree with each other.
      // Refused rather than corrected: guessing which of the two the caller
      // meant is how a receipt becomes a write-off.
      assertSignMatchesType(m);

      const bal = await this.lockBalance(sys, m.productId, m.warehouseId, m.branchId ?? null, m.lotId ?? null);
      const state: BalanceState = { qty: Number(bal.qty ?? 0), value: Number(bal.value ?? 0) };

      const costing =
        m.qty >= 0
          ? applyInbound(state, m.qty, m.unitCost ?? avgCostOf(state))
          : applyOutbound(state, -m.qty);

      // Overselling check. Now O(1) against the locked row — and correct under
      // concurrency, which the old SUM(qty) read could never be.
      if (!env.AULA_ALLOW_NEGATIVE_STOCK && (m.type === "issue" || m.type === "transfer_out") && m.qty < 0) {
        if (costing.newQty < -0.0001) {
          throw new ConflictError(
            `insufficient stock: ${state.qty} on hand, cannot issue ${Math.abs(m.qty)}`,
            [{ field: "qty", message: "exceeds available on-hand stock" }],
          ).withKey("err.insufficientStock", { onHand: state.qty, qty: Math.abs(m.qty) });
        }
      }

      const movedAt = m.movedAt ?? ctx.at;
      await this.qe.patchComputed(
        sys,
        "stockBalance",
        bal.id,
        {
          qty: costing.newQty,
          value: costing.newValue,
          avgCost: avgCostOf({ qty: costing.newQty, value: costing.newValue }),
          lastMovedAt: movedAt,
          // Backfill the branch if the row was created before one was known.
          ...(bal.branchId ? {} : { branchId: m.branchId ?? null }),
        },
        Number(bal.version),
      );

      const computed: Record<string, FieldValue> = {
        // The value applied to the balance, recorded verbatim — this equality is
        // the invariant `inventory/reconcile` asserts.
        value: costing.valueDelta,
        stockKey: stockKeyOf(m.productId, m.warehouseId, m.lotId ?? null),
      };
      const movement = await this.qe.createWithComputed(
        sys,
        "stockMovement",
        {
          productId: m.productId,
          warehouseId: m.warehouseId,
          lotId: m.lotId ?? null,
          qty: m.qty,
          type: m.type,
          unitCost: costing.appliedUnitCost,
          ref: m.ref ?? null,
          refType: m.refType ?? null,
          branchId: m.branchId ?? null,
          movedAt,
        },
        computed,
      );

      return {
        movement,
        appliedUnitCost: costing.appliedUnitCost,
        valueDelta: costing.valueDelta,
        onHandAfter: costing.newQty,
        duplicate: false,
      };
    });
  }

  /**
   * Change a balance's VALUE without moving any quantity.
   *
   * What landed cost needs: the freight on a container makes the goods worth
   * more without another item arriving. `writeMovement` cannot express it —
   * its arithmetic comes from `qty × unitCost`, and a zero quantity adds
   * nothing however large the cost.
   *
   * Written as a zero-quantity `adjustment` movement carrying the value, so
   * `inventory/reconcile` still sees balance == sum(movement.value) and the
   * ledger remains the single explanation of every lira in the account.
   *
   * A REDUCTION is clamped at the value on hand. Voiding a charge after the
   * goods have been sold has nothing left to take it out of, and driving the
   * balance negative is precisely the defect the costing rebuild removed. What
   * could not be taken back comes out as `residual` for the caller to book
   * where it actually belongs — against the cost of the goods that already
   * left, not against stock that is no longer there.
   */
  async adjustValue(
    ctx: RequestContext,
    a: {
      productId: string;
      warehouseId: string;
      lotId?: string | null;
      /** Signed. Positive adds value to the goods; negative takes it back. */
      valueDelta: number;
      ref?: string | null;
      refType?: StockRefType | null;
      branchId?: string | null;
      movedAt?: string;
    },
  ): Promise<{ valueDelta: number; residual: number; duplicate: boolean }> {
    const sys = this.sys(ctx);
    const requested = round2(a.valueDelta);

    return this.qe.runInTransaction(async () => {
      if (a.ref && a.refType) {
        const existing = await this.qe.list(sys, "stockMovement", {
          filters: [
            { field: "ref", op: "eq", value: a.ref },
            { field: "refType", op: "eq", value: a.refType },
            { field: "productId", op: "eq", value: a.productId },
            { field: "warehouseId", op: "eq", value: a.warehouseId },
            { field: "type", op: "eq", value: "adjustment" },
            { field: "lotId", op: "eq", value: a.lotId ?? null },
          ],
          pageSize: 1,
        });
        const prior = existing.items[0];
        // Idempotent on the same key as every other movement: re-applying a
        // charge returns what it did the first time rather than adding it twice.
        if (prior) {
          return { valueDelta: Number(prior.value ?? 0), residual: 0, duplicate: true };
        }
      }

      if (requested === 0) return { valueDelta: 0, residual: 0, duplicate: false };

      const bal = await this.lockBalance(sys, a.productId, a.warehouseId, a.branchId ?? null, a.lotId ?? null);
      const currentValue = round2(Number(bal.value ?? 0));
      const applied = requested < 0 ? -Math.min(-requested, Math.max(0, currentValue)) : requested;
      const residual = round2(requested - applied);
      const newValue = round2(currentValue + applied);
      const qty = Number(bal.qty ?? 0);
      const movedAt = a.movedAt ?? ctx.at;

      await this.qe.patchComputed(
        sys,
        "stockBalance",
        bal.id,
        {
          value: newValue,
          avgCost: avgCostOf({ qty, value: newValue }),
          lastMovedAt: movedAt,
          ...(bal.branchId ? {} : { branchId: a.branchId ?? null }),
        },
        Number(bal.version),
      );

      await this.qe.createWithComputed(
        sys,
        "stockMovement",
        {
          productId: a.productId,
          warehouseId: a.warehouseId,
          lotId: a.lotId ?? null,
          // Zero: nothing arrived and nothing left. Only the value moved.
          qty: 0,
          type: "adjustment",
          // Per-unit cost is meaningless on a zero-quantity row, and a figure
          // that means nothing is worse on a ledger than an explicit zero.
          unitCost: 0,
          ref: a.ref ?? null,
          refType: a.refType ?? null,
          branchId: a.branchId ?? null,
          movedAt,
        },
        { value: applied, stockKey: stockKeyOf(a.productId, a.warehouseId, a.lotId ?? null) },
      );

      return { valueDelta: applied, residual, duplicate: false };
    });
  }

  /** On-hand quantity for a product (optionally restricted to one warehouse). */
  async onHand(ctx: RequestContext, productId: string, warehouseId?: string): Promise<number> {
    const filters: Filter[] = [{ field: "productId", op: "eq", value: productId }];
    if (warehouseId) filters.push({ field: "warehouseId", op: "eq", value: warehouseId });
    const rows = await this.qe.aggregate(ctx, "stockBalance", {
      filters,
      measures: [{ op: "sum", field: "qty", as: "qty" }],
    });
    return round2(rows[0]?.measures.qty ?? 0);
  }

  /** Inventory valuation, optionally for one warehouse. */
  async valuation(ctx: RequestContext, warehouseId?: string): Promise<number> {
    const filters: Filter[] = warehouseId ? [{ field: "warehouseId", op: "eq", value: warehouseId }] : [];
    const rows = await this.qe.aggregate(ctx, "stockBalance", {
      filters,
      measures: [{ op: "sum", field: "value", as: "value" }],
    });
    return round2(rows[0]?.measures.value ?? 0);
  }

  /**
   * Current on-hand + value per product × warehouse.
   *
   * One indexed row per key, rather than the full-table aggregation over the
   * whole movement history this used to be — which ran on every load of the
   * stock-levels screen and once per line inside every checkout.
   */
  async onHandByKey(ctx: RequestContext, filters: Filter[] = []): Promise<OnHandRow[]> {
    const out: OnHandRow[] = [];
    await this.qe.listAll(ctx, "stockBalance", { filters }, (batch) => {
      for (const r of batch) {
        out.push({
          productId: String(r.productId),
          warehouseId: String(r.warehouseId),
          onHand: round2(Number(r.qty ?? 0)),
          reserved: round2(Number(r.reservedQty ?? 0)),
          value: round2(Number(r.value ?? 0)),
          avgCost: round2(Number(r.avgCost ?? 0)),
        });
      }
    });
    return out;
  }

  /**
   * On-hand as it stood at a point in time, replayed from the ledger.
   *
   * The balance row only knows *now*, so a historical position ("what did we
   * hold on 31 December") has to come from the movements. `asOf` is exclusive —
   * pass the first instant you want excluded, e.g. "2027-01-01".
   */
  async onHandAt(ctx: RequestContext, asOf: string): Promise<OnHandRow[]> {
    const rows = await this.qe.aggregate(ctx, "stockMovement", {
      filters: [{ field: "movedAt", op: "lt", value: asOf }],
      dimensions: [{ field: "productId" }, { field: "warehouseId" }],
      measures: [
        { op: "sum", field: "qty", as: "qty" },
        { op: "sum", field: "value", as: "value" },
      ],
    });
    return rows.map((r) => {
      const onHand = round2(r.measures.qty ?? 0);
      const value = round2(r.measures.value ?? 0);
      return {
        productId: String(r.keys.productId ?? ""),
        warehouseId: String(r.keys.warehouseId ?? ""),
        onHand,
        // Always zero on a historical read, and honestly so: a reservation is a
        // present-tense promise with no history in the ledger, so "what was
        // reserved on 31 December" is a question this data cannot answer.
        // Reporting today's figure against a past date would be worse than
        // reporting none.
        reserved: 0,
        value,
        avgCost: onHand > 0 ? round2(value / onHand) : 0,
      };
    });
  }
}

const globalRef = globalThis as unknown as { __aulaInventory?: InventoryService };

export async function getInventoryService(): Promise<InventoryService> {
  const qe = await getQueryEngine();
  globalRef.__aulaInventory ??= new InventoryService(qe);
  return globalRef.__aulaInventory;
}
