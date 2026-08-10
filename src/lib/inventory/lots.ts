/**
 * Lots: which batch goes out, and where a batch went.
 *
 * Two jobs, and they are the same data read from opposite ends:
 *
 *  - **Picking.** A tracked product's stock sits in several lots at once. An
 *    issue has to say which, and left to a person it is whichever box is nearest
 *    the door — so the oldest stock stays at the back until it expires. FEFO
 *    (first expired, first out) decides instead.
 *  - **Recall.** "Lot 2026-A is contaminated; who has it?" Answerable only
 *    because the issue recorded the lot as well as the receipt.
 *
 * A product that does not track lots never reaches any of this. That is the
 * whole compatibility story, and it is why turning lots on for one product
 * cannot destabilise the rest of the catalogue.
 */
import type { EntityRecord } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import { systemContext } from "@/lib/context/resolver";
import { ConflictError } from "@/lib/enforcement/errors";
import { logger } from "@/lib/observability/logger";

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

export const lotKeyOf = (productId: string, lotNumber: string): string => `${productId}:${lotNumber}`;

/** Statuses whose stock may not be picked. Quarantined goods stay valued. */
const UNPICKABLE = new Set(["quarantined", "expired", "consumed"]);

export interface LotStock {
  lotId: string;
  lotNumber: string;
  expiryDate: string | null;
  status: string;
  qty: number;
  reserved: number;
  /** What can actually be picked from this lot right now. */
  available: number;
}

export interface Allocation {
  lotId: string;
  lotNumber: string;
  qty: number;
  expiryDate: string | null;
}

/**
 * Order lots for picking: first expired, first out.
 *
 * FEFO rather than FIFO. For anything with a date, the lot that expires soonest
 * is the one to move, and it is not necessarily the one that arrived first — a
 * later delivery with a shorter remaining life is more urgent than an older one
 * with a year left. Lots without an expiry fall back to oldest-received, which
 * is FIFO, and they sort AFTER dated lots: a dated lot is on a clock and an
 * undated one is not.
 *
 * Pure, so the ordering can be tested without a database — it is the part that
 * decides which stock quietly goes out of date.
 */
export function fefoOrder(lots: readonly LotStock[]): LotStock[] {
  return [...lots].sort((a, b) => {
    if (a.expiryDate && b.expiryDate) {
      // ISO dates compare lexicographically; see `data/query`.
      if (a.expiryDate !== b.expiryDate) return a.expiryDate < b.expiryDate ? -1 : 1;
    } else if (a.expiryDate) {
      return -1;
    } else if (b.expiryDate) {
      return 1;
    }
    // Same date, or neither dated: the older lot id is the earlier receipt.
    return Number(a.lotId) - Number(b.lotId);
  });
}

/**
 * Split a quantity across lots in picking order.
 *
 * Returns what CAN be covered and how much is short, rather than throwing. The
 * caller decides what a shortfall means: refusing an order is one answer,
 * shipping what there is and back-ordering the rest is another, and a function
 * that decides for them can only give the first.
 */
export function allocateFefo(
  lots: readonly LotStock[],
  qty: number,
): { allocations: Allocation[]; shortfall: number } {
  let remaining = round4(qty);
  const allocations: Allocation[] = [];
  for (const lot of fefoOrder(lots)) {
    if (remaining <= 1e-9) break;
    const take = Math.min(lot.available, remaining);
    if (take <= 1e-9) continue;
    allocations.push({
      lotId: lot.lotId,
      lotNumber: lot.lotNumber,
      qty: round4(take),
      expiryDate: lot.expiryDate,
    });
    remaining = round4(remaining - take);
  }
  return { allocations, shortfall: round4(Math.max(0, remaining)) };
}

/** What is on hand of a product in a warehouse, lot by lot. */
export async function lotStock(
  ctx: RequestContext,
  productId: string,
  warehouseId: string,
  opts: { includeUnpickable?: boolean } = {},
): Promise<LotStock[]> {
  const qe = await getQueryEngine();
  const balances = await qe.listComplete(ctx, "stockBalance", {
    filters: [
      { field: "productId", op: "eq", value: productId },
      { field: "warehouseId", op: "eq", value: warehouseId },
    ],
  });
  const withLots = balances.filter((b) => b.lotId && Number(b.qty ?? 0) > 0);
  if (withLots.length === 0) return [];

  const lots = await qe.listByIds(ctx, "stockLot", withLots.map((b) => String(b.lotId)));
  const byId = new Map(lots.map((l) => [String(l.id), l]));

  const rows: LotStock[] = [];
  for (const b of withLots) {
    const lot = byId.get(String(b.lotId));
    if (!lot) continue;
    const status = String(lot.status ?? "active");
    // Quarantined and expired stock is still ON HAND and still valued — it is
    // physically there. It simply cannot be picked, which is a different thing
    // from not existing, and reporting it as absent is how a stocktake fails.
    const pickable = !UNPICKABLE.has(status);
    if (!pickable && !opts.includeUnpickable) continue;
    const qty = Number(b.qty ?? 0);
    const reserved = Number(b.reservedQty ?? 0);
    rows.push({
      lotId: String(b.lotId),
      lotNumber: String(lot.lotNumber ?? ""),
      expiryDate: lot.expiryDate ? String(lot.expiryDate) : null,
      status,
      qty,
      reserved,
      available: pickable ? round4(Math.max(0, qty - reserved)) : 0,
    });
  }
  return fefoOrder(rows);
}

/**
 * Which lots to take a quantity from, in picking order.
 *
 * The entry point for every issue of a tracked product. Refuses rather than
 * partially allocating: a delivery note that silently ships less than it says
 * is worse than one that will not post.
 */
export async function pickLots(
  ctx: RequestContext,
  productId: string,
  warehouseId: string,
  qty: number,
): Promise<Allocation[]> {
  const stock = await lotStock(ctx, productId, warehouseId);
  const { allocations, shortfall } = allocateFefo(stock, qty);
  if (shortfall > 1e-9) {
    const held = stock.reduce((t, l) => t + l.reserved, 0);
    throw new ConflictError(
      `insufficient pickable stock: short by ${shortfall}` +
        (held > 0 ? ` (${held} is reserved)` : "") +
        (stock.length === 0 ? " — no active lot has any" : ""),
      [{ field: "qty", message: "exceeds what the available lots hold" }],
    ).withKey("err.insufficientPickable", { shortfall });
  }
  return allocations;
}

export interface LotInput {
  productId: string;
  lotNumber: string;
  expiryDate?: string | null;
  manufacturedDate?: string | null;
  supplierId?: string | null;
  grnId?: string | null;
  serialNumber?: string | null;
}

/**
 * Find or create the lot a receipt is delivering.
 *
 * Idempotent on (product, lot number): receiving the same batch twice — a split
 * delivery, a re-posted receipt — adds to the lot that exists rather than
 * creating a second row with the same number, which would divide one batch in
 * two and make a recall find half of it.
 *
 * An expiry is proposed from the product's shelf life when the delivery note
 * does not state one. A proposal, and only when there is nothing better: the
 * date printed on the box always wins.
 */
export async function ensureLot(ctx: RequestContext, input: LotInput): Promise<EntityRecord> {
  const qe = await getQueryEngine();
  const sys = systemContext(ctx.tenantId, ctx.orgId, {
    userId: ctx.userId,
    displayName: ctx.displayName,
    email: ctx.email,
  });
  const key = lotKeyOf(input.productId, input.lotNumber);

  const existing = (
    await qe.list(sys, "stockLot", { filters: [{ field: "lotKey", op: "eq", value: key }], pageSize: 1 })
  ).items[0];
  if (existing) return existing;

  let expiryDate = input.expiryDate ?? null;
  if (!expiryDate) {
    const product = await qe.get(sys, "product", input.productId).catch(() => null);
    const shelfLife = Number(product?.shelfLifeDays ?? 0);
    if (shelfLife > 0) {
      const from = new Date(input.manufacturedDate ?? ctx.at);
      from.setDate(from.getDate() + shelfLife);
      expiryDate = from.toISOString().slice(0, 10);
    }
  }

  try {
    return await qe.createWithComputed(
      sys,
      "stockLot",
      {
        productId: input.productId,
        lotNumber: input.lotNumber,
        expiryDate,
        manufacturedDate: input.manufacturedDate ?? null,
        supplierId: input.supplierId ?? null,
        grnId: input.grnId ?? null,
        serialNumber: input.serialNumber ?? null,
        receivedAt: ctx.at,
        status: "active",
      },
      { lotKey: key },
    );
  } catch {
    // Lost the race to create it — the unique index on `lotKey` rejected us, so
    // the winner's row is committed.
    const won = (
      await qe.list(sys, "stockLot", { filters: [{ field: "lotKey", op: "eq", value: key }], pageSize: 1 })
    ).items[0];
    if (won) return won;
    throw new ConflictError(`could not create lot ${input.lotNumber}`).withKey("err.lotCreateFailed", { lot: input.lotNumber });
  }
}

export interface TraceEntry {
  movementId: string;
  type: string;
  qty: number;
  warehouseId: string;
  movedAt: string;
  refType: string | null;
  ref: string | null;
  /** The document's number and, for an issue, who received the goods. */
  documentNumber: string | null;
  counterpartyName: string | null;
}

/**
 * Where a lot came from and where it went.
 *
 * The recall question. Built from the movement ledger rather than from the
 * documents, because the ledger is the only place that records what physically
 * moved — a document can be edited after the fact, and a movement cannot.
 */
export async function traceLot(
  ctx: RequestContext,
  lotId: string,
): Promise<{ lot: EntityRecord; onHand: number; inbound: TraceEntry[]; outbound: TraceEntry[] }> {
  const qe = await getQueryEngine();
  const lot = await qe.get(ctx, "stockLot", lotId);
  const movements = await qe.listComplete(ctx, "stockMovement", {
    filters: [{ field: "lotId", op: "eq", value: lotId }],
  });

  // Resolve the documents these movements point at, so the answer names an
  // invoice and a customer rather than a pair of ids.
  const byType = new Map<string, Set<string>>();
  for (const m of movements) {
    if (!m.ref || !m.refType) continue;
    const set = byType.get(String(m.refType)) ?? new Set<string>();
    set.add(String(m.ref));
    byType.set(String(m.refType), set);
  }
  const DOC_ENTITY: Record<string, string> = {
    goodsReceipt: "goodsReceipt",
    invoice: "invoice",
    deliveryNote: "deliveryNote",
    salesReturn: "salesReturn",
    purchaseReturn: "purchaseReturn",
    stockTransfer: "stockTransfer",
    adjustment: "stockAdjustment",
  };
  const docs = new Map<string, EntityRecord>();
  for (const [refType, ids] of byType) {
    const entity = DOC_ENTITY[refType];
    if (!entity) continue;
    // A `:void` suffix is a synthetic ref for a reversal; the document behind it
    // is the original.
    const real = [...ids].map((id) => id.replace(/:void$/, ""));
    for (const row of await qe.listByIds(ctx, entity, real)) {
      docs.set(`${refType}:${String(row.id)}`, row);
    }
  }

  const partyIds = new Set<string>();
  for (const doc of docs.values()) {
    if (doc.accountId) partyIds.add(`account:${String(doc.accountId)}`);
    if (doc.supplierId) partyIds.add(`supplier:${String(doc.supplierId)}`);
  }
  const accounts = await qe.listByIds(
    ctx,
    "account",
    [...partyIds].filter((k) => k.startsWith("account:")).map((k) => k.slice(8)),
  );
  const suppliers = await qe.listByIds(
    ctx,
    "supplier",
    [...partyIds].filter((k) => k.startsWith("supplier:")).map((k) => k.slice(9)),
  );
  const partyName = new Map<string, string>([
    ...accounts.map((a) => [`account:${String(a.id)}`, String(a.name)] as const),
    ...suppliers.map((s) => [`supplier:${String(s.id)}`, String(s.name)] as const),
  ]);

  const toEntry = (m: EntityRecord): TraceEntry => {
    const refType = m.refType ? String(m.refType) : null;
    const ref = m.ref ? String(m.ref) : null;
    const doc = refType && ref ? docs.get(`${refType}:${ref.replace(/:void$/, "")}`) : undefined;
    const party = doc?.accountId
      ? partyName.get(`account:${String(doc.accountId)}`)
      : doc?.supplierId
        ? partyName.get(`supplier:${String(doc.supplierId)}`)
        : undefined;
    return {
      movementId: String(m.id),
      type: String(m.type),
      qty: Number(m.qty ?? 0),
      warehouseId: String(m.warehouseId),
      movedAt: String(m.movedAt ?? m.createdAt ?? ""),
      refType,
      ref,
      documentNumber: doc?.number ? String(doc.number) : null,
      counterpartyName: party ?? null,
    };
  };

  const entries = movements.map(toEntry).sort((a, b) => (a.movedAt < b.movedAt ? -1 : a.movedAt > b.movedAt ? 1 : 0));
  return {
    lot,
    onHand: round4(entries.reduce((t, e) => t + e.qty, 0)),
    inbound: entries.filter((e) => e.qty > 0),
    outbound: entries.filter((e) => e.qty < 0),
  };
}

/**
 * Mark lots whose date has passed.
 *
 * Run nightly. It changes status only — the stock stays on the shelf and stays
 * valued, because it is physically there and writing it off is a decision with
 * a journal entry behind it. What changes is that it can no longer be picked,
 * which is the part a person should not be relied on to notice.
 */
export async function expireLots(ctx: RequestContext, asOf?: string): Promise<number> {
  const qe = await getQueryEngine();
  const sys = systemContext(ctx.tenantId, ctx.orgId);
  const today = (asOf ?? ctx.at).slice(0, 10);

  const due = await qe.listComplete(sys, "stockLot", {
    filters: [
      { field: "status", op: "eq", value: "active" },
      // Strictly before today: a lot dated today is good until the day is out.
      { field: "expiryDate", op: "lt", value: today },
    ],
  });
  let expired = 0;
  for (const lot of due) {
    // NULL-safe by construction: the memory and SQL adapters agree that
    // `NULL < x` is false, so a lot with no expiry is never swept.
    if (!lot.expiryDate) continue;
    await qe.patchComputed(sys, "stockLot", String(lot.id), { status: "expired" });
    expired += 1;
  }
  if (expired > 0) logger.info("lots expired", { expired, asOf: today });
  return expired;
}
