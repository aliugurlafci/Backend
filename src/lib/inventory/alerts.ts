/**
 * Stock condition detection.
 *
 * Scans the maintained balances and opens or closes `stockAlert` records. Every
 * open emits `stockAlert.created`, which the automation engine already knows how
 * to act on — that is the whole reason this is a record and not a new trigger
 * kind (see `entities/stock-alert.ts`).
 *
 * Two properties matter more than the detection itself:
 *
 *  - **It does not repeat.** An alert whose condition is still true is left
 *    alone. Re-announcing the same shortage nightly is how an alert channel
 *    becomes noise that gets muted, taking the urgent messages with it.
 *  - **It closes itself.** When stock is replenished the alert resolves, so the
 *    open list is what is actually wrong right now rather than an ever-growing
 *    log. If it drops low again, that is a NEW alert — a second shortage is a
 *    second event, not a continuation of the first.
 */
import type { EntityRecord } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import { getDomainService } from "@/lib/domain";
import { logger } from "@/lib/observability/logger";

export type AlertKind = "reorder" | "negative" | "stagnant" | "expiring";

/**
 * How long a valued balance may sit unmoved before it counts as stagnant.
 *
 * A quarter, because that is roughly when slow-moving stock stops being "we
 * haven't sold one lately" and starts being working capital on a shelf.
 */
export const STAGNANT_DAYS = 90;

/**
 * How far ahead an expiry is worth warning about.
 *
 * Thirty days: long enough to discount it, return it to the supplier, or push
 * it to a customer who will get through it; short enough that the list is not
 * everything in the warehouse.
 */
export const EXPIRY_WARNING_DAYS = 30;

export interface AlertScanResult {
  scanned: number;
  opened: number;
  resolved: number;
  /** Still open from earlier runs — deliberately untouched, and not re-announced. */
  ongoing: number;
}

interface Candidate {
  kind: AlertKind;
  balance: EntityRecord;
  qty: number;
  threshold: number | null;
}

/** ISO day difference; both sides are ISO-8601 strings. */
function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

/**
 * Which condition, if any, a balance is in.
 *
 * At most one per balance, most severe first: a negative balance is also below
 * its reorder level, and telling someone to reorder is the wrong instruction
 * when the real problem is that the books say they hold minus four.
 */
export function classifyBalance(
  balance: EntityRecord,
  product: EntityRecord | undefined,
  nowIso: string,
  lot?: EntityRecord,
): Candidate | null {
  const qty = Number(balance.qty ?? 0);

  if (qty < 0) return { kind: "negative", balance, qty, threshold: 0 };

  // A batch running out of time, while it still holds stock.
  //
  // Ranked above "below reorder level" deliberately: a low balance is a buying
  // decision that can wait a day, whereas stock about to expire is a selling
  // decision with a deadline. And the warning has to come BEFORE the date —
  // afterwards the goods are already a write-off, which is precisely what
  // tracking SKT exists to avoid.
  if (lot?.expiryDate && qty > 0 && String(lot.status ?? "active") === "active") {
    const days = daysBetween(nowIso, String(lot.expiryDate));
    if (days <= EXPIRY_WARNING_DAYS) {
      return { kind: "expiring", balance, qty, threshold: days };
    }
  }

  const reorderLevel = Number(product?.reorderLevel ?? 0);
  // A reorder level of 0 means "not watched", not "alert at zero". Treating it
  // as a threshold would open an alert for every product anyone ever let run
  // out, including the ones deliberately not stocked.
  if (reorderLevel > 0 && qty <= reorderLevel) {
    return { kind: "reorder", balance, qty, threshold: reorderLevel };
  }

  const lastMoved = balance.lastMovedAt ? String(balance.lastMovedAt) : "";
  // Only stock that is actually held and valued. A zero balance is not stagnant,
  // it is absent — and it would otherwise dominate the list.
  if (qty > 0 && Number(balance.value ?? 0) > 0 && lastMoved && daysBetween(lastMoved, nowIso) >= STAGNANT_DAYS) {
    return { kind: "stagnant", balance, qty, threshold: STAGNANT_DAYS };
  }

  return null;
}

/**
 * Scan every balance and reconcile the open alerts against it.
 *
 * Reads through `listComplete`, which raises rather than truncating: a scan that
 * silently saw only the first page would resolve alerts for balances it never
 * looked at, reporting problems as fixed because it stopped reading.
 */
export async function scanStockAlerts(ctx: RequestContext): Promise<AlertScanResult> {
  const qe = await getQueryEngine();
  const domain = await getDomainService();
  const result: AlertScanResult = { scanned: 0, opened: 0, resolved: 0, ongoing: 0 };

  const balances = await qe.listComplete(ctx, "stockBalance", {});
  result.scanned = balances.length;
  if (balances.length === 0) return result;

  // Products and warehouses in one read each, for the thresholds and the names
  // that go into the message body.
  const products = new Map<string, EntityRecord>();
  for (const p of await qe.listComplete(ctx, "product", {})) products.set(String(p.id), p);
  const warehouses = new Map<string, EntityRecord>();
  for (const w of await qe.listComplete(ctx, "warehouse", {})) warehouses.set(String(w.id), w);

  const open = await qe.listComplete(ctx, "stockAlert", {
    filters: [{ field: "status", op: "eq", value: "open" }],
  });
  // Keyed by stockKey AND kind: one balance can move from "reorder" to
  // "negative", and those are different problems needing different responses.
  const openByKey = new Map<string, EntityRecord>();
  for (const a of open) openByKey.set(`${String(a.stockKey)}|${String(a.kind)}`, a);

  const stillTrue = new Set<string>();

  // Lots for the balances that have one. Read by id rather than whole-table:
  // the lot set grows with every batch ever received, and only the ones with
  // stock on hand can possibly be expiring.
  const lotIds = [...new Set(balances.filter((b) => b.lotId).map((b) => String(b.lotId)))];
  const lots = new Map<string, EntityRecord>();
  for (const l of lotIds.length ? await qe.listByIds(ctx, "stockLot", lotIds) : []) {
    lots.set(String(l.id), l);
  }

  for (const balance of balances) {
    const product = products.get(String(balance.productId ?? ""));
    const lot = balance.lotId ? lots.get(String(balance.lotId)) : undefined;
    const candidate = classifyBalance(balance, product, ctx.at, lot);
    if (!candidate) continue;

    const key = `${String(balance.stockKey)}|${candidate.kind}`;
    stillTrue.add(key);
    if (openByKey.has(key)) {
      result.ongoing += 1;
      continue; // already reported; saying it again is how alerts get muted
    }

    const warehouse = warehouses.get(String(balance.warehouseId ?? ""));
    // Through the domain service, not the query engine: this is what stages the
    // outbox event, and the event is the entire point — an alert row nobody is
    // told about is a report, not an alert.
    await domain.create(ctx, "stockAlert", {
      kind: candidate.kind,
      status: "open",
      stockKey: String(balance.stockKey),
      productId: String(balance.productId),
      warehouseId: String(balance.warehouseId),
      qty: candidate.qty,
      threshold: candidate.threshold,
      detectedAt: ctx.at,
      productName: String(product?.name ?? balance.productId),
      warehouseName: String(warehouse?.name ?? balance.warehouseId),
    });
    result.opened += 1;
  }

  // Anything open whose condition no longer holds.
  for (const [key, alert] of openByKey) {
    if (stillTrue.has(key)) continue;
    await qe.patchComputed(ctx, "stockAlert", String(alert.id), {
      status: "resolved",
      resolvedAt: ctx.at,
    });
    result.resolved += 1;
  }

  logger.info("stock alerts scanned", { ...result });
  return result;
}
