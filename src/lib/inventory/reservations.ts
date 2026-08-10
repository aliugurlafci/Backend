/**
 * Holding stock for a document that has not shipped yet.
 *
 * Without this, sellable stock IS on-hand stock: two salespeople both read "one
 * left", both promise it, and neither finds out until one tries to ship. By then
 * both customers have a delivery date.
 *
 * Built on exactly the mechanism Faz 3 established for the balance itself — a
 * LOCKED read of the row, then a write, inside the caller's transaction. That is
 * not a stylistic choice: a plain read plus optimistic retry does not work here.
 * Under MySQL's REPEATABLE READ the retry re-reads the same snapshot inside the
 * same transaction and spins until it gives up, reporting a version conflict
 * instead of "not enough stock" — a confusing error for the one condition the
 * caller most needs stated plainly.
 *
 * `available = qty - reservedQty` is the only definition of sellable, and it is
 * enforced at the point of reserving. Checking it anywhere else — in a service,
 * in the UI — is a check two callers can pass simultaneously.
 */
import type { RequestContext } from "@/lib/context/types";
import type { EntityRecord } from "@/lib/metadata/types";
import { getQueryEngine } from "@/lib/data/store";
import { systemContext } from "@/lib/context/resolver";
import { ConflictError } from "@/lib/enforcement/errors";
import { logger } from "@/lib/observability/logger";

const RESERVATION = "stockReservation";
const BALANCE = "stockBalance";

export const stockKeyOf = (productId: string, warehouseId: string): string => `${productId}:${warehouseId}`;
const reservationKeyOf = (refType: string, refId: string, stockKey: string): string => `${refType}:${refId}:${stockKey}`;

export interface ReserveInput {
  productId: string;
  warehouseId: string;
  /** Base units. Everything that touches the ledger is in base units. */
  qty: number;
  refType: string;
  refId: string;
  branchId?: string | null;
  expiresAt?: string | null;
}

export interface Availability {
  onHand: number;
  reserved: number;
  available: number;
}

/**
 * What can still be promised.
 *
 * Summed across every balance for the product in that warehouse. For an
 * ordinary product that is one row; for a lot-tracked one it is a row per
 * batch, and a promise is made against the PRODUCT, not against a batch —
 * which box goes out is decided when somebody picks it, and by then a shorter-
 * dated batch may have arrived.
 */
export async function availability(
  ctx: RequestContext,
  productId: string,
  warehouseId: string,
): Promise<Availability> {
  const qe = await getQueryEngine();
  const rows = await qe.listComplete(ctx, BALANCE, {
    filters: [
      { field: "productId", op: "eq", value: productId },
      { field: "warehouseId", op: "eq", value: warehouseId },
    ],
  });
  const onHand = round4(rows.reduce((t, r) => t + Number(r.qty ?? 0), 0));
  const reserved = round4(rows.reduce((t, r) => t + Number(r.reservedQty ?? 0), 0));
  return { onHand, reserved, available: round4(onHand - reserved) };
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/**
 * Hold stock for a document.
 *
 * Idempotent on `(refType, refId, stockKey)`: reserving the same document's
 * stock twice REPLACES the hold rather than adding to it. That is what makes
 * "save the order again" safe — the alternative doubles the hold, and the
 * quantity nobody releases is invisible until the warehouse reports less
 * available than it has.
 */
export async function reserve(ctx: RequestContext, input: ReserveInput): Promise<EntityRecord> {
  const qe = await getQueryEngine();
  const sys = systemContext(ctx.tenantId, ctx.orgId, { userId: ctx.userId, displayName: ctx.displayName, email: ctx.email });
  const stockKey = stockKeyOf(input.productId, input.warehouseId);
  const key = reservationKeyOf(input.refType, input.refId, stockKey);
  const qty = round4(Number(input.qty));

  if (!(qty > 0)) throw new ConflictError("a reservation must be for a positive quantity");

  return qe.runInTransaction(async () => {
    // The lock, and the reason this is correct under concurrency. Everything
    // below reads and writes the row it holds.
    //
    // The row locked is the (product, warehouse) one, even when the stock
    // itself lives in per-lot rows. A hold is a promise about the product —
    // which batch fills it is decided at picking — so one row has to carry the
    // reservation and serialise the callers, and this is that row.
    let balance = await qe.getForUpdate(sys, BALANCE, [{ field: "stockKey", op: "eq", value: stockKey }]);
    if (!balance) {
      // A lot-tracked product has no two-part balance: its goods are in the lot
      // rows. Create the header to hold the reservation on — quantity zero,
      // because no stock lives here; the on-hand figure is summed below.
      const lotRows = await qe.listComplete(sys, BALANCE, {
        filters: [
          { field: "productId", op: "eq", value: input.productId },
          { field: "warehouseId", op: "eq", value: input.warehouseId },
        ],
      });
      if (lotRows.length === 0) {
        throw new ConflictError(`no stock on hand for this product in that warehouse`, [
          { field: "qty", message: "nothing available to reserve" },
        ]);
      }
      balance = await qe.createWithComputed(
        sys,
        BALANCE,
        {
          productId: input.productId,
          warehouseId: input.warehouseId,
          branchId: input.branchId ?? null,
          lotId: null,
          qty: 0,
          value: 0,
          lastMovedAt: null,
        },
        { stockKey, avgCost: 0 },
      );
    }

    const existing = await qe.list(sys, RESERVATION, {
      filters: [{ field: "reservationKey", op: "eq", value: key }],
      pageSize: 1,
    });
    const previous = existing.items[0];
    // A replacement releases what this document already held before asking for
    // the new amount, so growing a hold from 3 to 5 needs 2 more — not 5 more.
    const alreadyHeld = previous && String(previous.status) === "active" ? Number(previous.qty ?? 0) : 0;

    // On hand across every batch, because the promise is about the product.
    // The header row itself holds no stock for a lot-tracked item.
    const siblings = await qe.listComplete(sys, BALANCE, {
      filters: [
        { field: "productId", op: "eq", value: input.productId },
        { field: "warehouseId", op: "eq", value: input.warehouseId },
      ],
    });
    const onHand = round4(siblings.reduce((t, r) => t + Number(r.qty ?? 0), 0));
    const reserved = round4(siblings.reduce((t, r) => t + Number(r.reservedQty ?? 0), 0));
    const availableToThisCaller = round4(onHand - reserved + alreadyHeld);
    if (qty > availableToThisCaller + 1e-9) {
      throw new ConflictError(
        `insufficient available stock: ${availableToThisCaller} available (${onHand} on hand, ${reserved} reserved), cannot hold ${qty}`,
        [{ field: "qty", message: "exceeds available stock" }],
      ).withKey("err.insufficientAvailable", { available: availableToThisCaller, onHand, reserved, qty });
    }

    await qe.patchComputed(
      sys,
      BALANCE,
      String(balance.id),
      { reservedQty: round4(reserved - alreadyHeld + qty) },
      Number(balance.version),
    );

    if (previous) {
      return qe.patchComputed(sys, RESERVATION, String(previous.id), {
        qty,
        status: "active",
        releasedAt: null,
        expiresAt: input.expiresAt ?? null,
      });
    }
    return qe.createWithComputed(
      sys,
      RESERVATION,
      {
        stockKey,
        productId: input.productId,
        warehouseId: input.warehouseId,
        qty,
        refType: input.refType,
        refId: input.refId,
        status: "active",
        expiresAt: input.expiresAt ?? null,
      },
      { reservationKey: key },
    );
  });
}

/**
 * Give back everything a document was holding.
 *
 * `consumed` rather than `released` when the goods actually shipped: the issue
 * has already reduced `qty`, so the hold must drop at the same moment or the
 * same units are subtracted twice — once as stock that left and once as stock
 * still promised.
 */
export async function release(
  ctx: RequestContext,
  refType: string,
  refId: string,
  reason: "released" | "consumed" = "released",
): Promise<number> {
  const qe = await getQueryEngine();
  const sys = systemContext(ctx.tenantId, ctx.orgId, { userId: ctx.userId, displayName: ctx.displayName, email: ctx.email });

  const held = await qe.listComplete(sys, RESERVATION, {
    filters: [
      { field: "refType", op: "eq", value: refType },
      { field: "refId", op: "eq", value: refId },
      { field: "status", op: "eq", value: "active" },
    ],
  });
  if (held.length === 0) return 0;

  let releasedCount = 0;
  for (const row of held) {
    await qe.runInTransaction(async () => {
      const balance = await qe.getForUpdate(sys, BALANCE, [{ field: "stockKey", op: "eq", value: String(row.stockKey) }]);
      if (balance) {
        // Floored at zero. A negative reserved figure would make `available`
        // exceed what is physically there, which is worse than losing track of
        // a hold — it promises stock that does not exist.
        const next = Math.max(0, round4(Number(balance.reservedQty ?? 0) - Number(row.qty ?? 0)));
        await qe.patchComputed(sys, BALANCE, String(balance.id), { reservedQty: next }, Number(balance.version));
      }
      await qe.patchComputed(sys, RESERVATION, String(row.id), { status: reason, releasedAt: ctx.at });
      releasedCount += 1;
    });
  }
  return releasedCount;
}

/**
 * Drop holds whose expiry has passed.
 *
 * A reservation with no end is a slow leak: a quote nobody followed up holds
 * stock for ever, and the only symptom is a warehouse reporting less available
 * than it has — which reads as a stock problem rather than a stale document.
 */
export async function expireReservations(ctx: RequestContext): Promise<number> {
  const qe = await getQueryEngine();
  const sys = systemContext(ctx.tenantId, ctx.orgId);
  const due = await qe.listComplete(sys, RESERVATION, {
    filters: [
      { field: "status", op: "eq", value: "active" },
      { field: "expiresAt", op: "lt", value: ctx.at },
    ],
  });
  let expired = 0;
  for (const row of due) {
    expired += await release(ctx, String(row.refType), String(row.refId), "released");
  }
  if (expired) logger.info("stock reservations expired", { expired });
  return expired;
}
