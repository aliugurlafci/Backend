/**
 * Business condition detection outside stock.
 *
 * The sibling of `inventory/alerts.ts`, and deliberately built the same way: it
 * opens an `operationsAlert` when a condition becomes true, leaves it alone
 * while it stays true, and resolves it when it clears. Every open emits
 * `operationsAlert.created`, which the automation engine already acts on — that
 * is why these are records and not five new trigger kinds.
 *
 * The conditions themselves were all computable before this existed; nothing
 * computed them. A purchase order sat past its promised date and the only way
 * to notice was for somebody to open it. That is the gap: the data was there,
 * the question was never asked.
 *
 * Not repeating and self-closing matter more than the detection. Re-announcing
 * the same late order every night is how an alert channel becomes noise that
 * gets muted, taking the urgent messages with it.
 */
import type { EntityRecord } from "@/lib/metadata/types";
import { orgText } from "@/lib/i18n/texts";
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import { getDomainService } from "@/lib/domain";
import { logger } from "@/lib/observability/logger";

export type OpsAlertKind = "po_overdue" | "transfer_stuck" | "count_variance" | "till_variance" | "price_variance";

/**
 * Thresholds.
 *
 * Deliberately constants rather than settings. A threshold nobody has ever
 * tuned is better as a documented number than as a configuration row that reads
 * as deliberate when it is only the default — and every one of these is a
 * judgement about when something stops being ordinary, which is worth writing
 * down next to the rule that uses it.
 */
/** A transfer dispatched and not received within this many days is lost, not late. */
export const TRANSIT_DAYS = 3;
/** Money written off by one physical count before it wants a second opinion. */
export const COUNT_VARIANCE = 500;
/** Cash a till may be out by at close before somebody is asked about it. */
export const TILL_VARIANCE = 50;
/** Difference between what goods were received at and what the supplier billed. */
export const PRICE_VARIANCE = 100;

export interface OpsAlertScanResult {
  opened: number;
  resolved: number;
  ongoing: number;
  scanned: number;
}

interface Candidate {
  kind: OpsAlertKind;
  refType: string;
  refId: string;
  title: string;
  amount: number;
  threshold: number;
  branchId?: string | null;
}

/** Whole days between two ISO-8601 instants. */
function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

/** A purchase order past the date the supplier promised, still awaiting goods. */
export function classifyPurchaseOrder(po: EntityRecord, nowIso: string): Candidate | null {
  // `partial` counts: some of it arrived, the rest is still late. `received`,
  // `cancelled` and `rejected` do not — there is nothing left to chase.
  const status = String(po.status ?? "");
  if (status !== "approved" && status !== "partial") return null;
  const expected = po.expectedDate ? String(po.expectedDate) : "";
  if (!expected) return null; // no promised date means nothing to be late against
  const late = daysBetween(expected, nowIso);
  if (late <= 0) return null;
  return {
    kind: "po_overdue",
    refType: "purchaseOrder",
    refId: String(po.id),
    title: orgText("alert.poOverdue.title", { number: String(po.number ?? po.id), days: late }),
    amount: late,
    threshold: 0,
    branchId: (po.branchId as string | null) ?? null,
  };
}

/** Goods dispatched from one warehouse and never received at the other. */
export function classifyTransfer(transfer: EntityRecord, nowIso: string): Candidate | null {
  if (String(transfer.status ?? "") !== "in_transit") return null;
  const dispatched = transfer.dispatchedAt ? String(transfer.dispatchedAt) : "";
  if (!dispatched) return null;
  const days = daysBetween(dispatched, nowIso);
  if (days < TRANSIT_DAYS) return null;
  return {
    kind: "transfer_stuck",
    refType: "stockTransfer",
    refId: String(transfer.id),
    // Worth stating plainly: while it sits here the goods are on the books but
    // counted in neither warehouse, so both locations are wrong.
    title: orgText("alert.transferStuck.title", { number: String(transfer.number ?? transfer.id), days }),
    amount: days,
    threshold: TRANSIT_DAYS,
    branchId: (transfer.branchId as string | null) ?? null,
  };
}

/** A posted count whose write-off is large enough to want a second opinion. */
export function classifyCount(count: EntityRecord): Candidate | null {
  if (String(count.status ?? "") !== "posted") return null;
  const value = Math.abs(Number(count.varianceValue ?? 0));
  if (value < COUNT_VARIANCE) return null;
  return {
    kind: "count_variance",
    refType: "stockCount",
    refId: String(count.id),
    title: orgText("alert.countWriteOff.title", { number: String(count.id), value: value.toFixed(2), lines: String(count.varianceCount ?? 0) }),
    amount: value,
    threshold: COUNT_VARIANCE,
  };
}

/** A till that did not balance at close. */
export function classifySession(session: EntityRecord): Candidate | null {
  if (String(session.status ?? "") !== "closed") return null;
  const variance = Math.abs(Number(session.variance ?? 0));
  if (variance < TILL_VARIANCE) return null;
  const signed = Number(session.variance ?? 0);
  return {
    kind: "till_variance",
    refType: "posSession",
    refId: String(session.id),
    title: orgText(signed < 0 ? "alert.tillShort.title" : "alert.tillOver.title", { number: String(session.number ?? session.id), amount: variance.toFixed(2) }),
    amount: variance,
    threshold: TILL_VARIANCE,
    branchId: (session.branchId as string | null) ?? null,
  };
}

/** A supplier bill that differs materially from what the goods were received at. */
export function classifyBill(bill: EntityRecord): Candidate | null {
  // Only once matched: before that there is nothing to compare against, and the
  // variance column is null rather than zero precisely so the two are distinct.
  if (bill.priceVariance === null || bill.priceVariance === undefined) return null;
  const variance = Math.abs(Number(bill.priceVariance));
  if (variance < PRICE_VARIANCE) return null;
  return {
    kind: "price_variance",
    refType: "vendorBill",
    refId: String(bill.id),
    title: orgText("alert.billVariance.title", { number: String(bill.number ?? bill.id), amount: variance.toFixed(2) }),
    amount: variance,
    threshold: PRICE_VARIANCE,
  };
}

/**
 * Scan every source and reconcile the open alerts against what is true now.
 *
 * Reads through `listComplete`, which raises rather than truncating. A scan that
 * silently saw only the first page would resolve alerts for documents it never
 * looked at — reporting problems as fixed because it stopped reading, which is
 * worse than not scanning at all.
 */
export async function scanOperationsAlerts(ctx: RequestContext): Promise<OpsAlertScanResult> {
  const qe = await getQueryEngine();
  const domain = await getDomainService();
  const result: OpsAlertScanResult = { opened: 0, resolved: 0, ongoing: 0, scanned: 0 };

  // Each source is read narrowed to the states that can possibly qualify, so a
  // years-old archive of received orders is never loaded to be discarded.
  const [orders, transfers, counts, sessions, bills] = await Promise.all([
    qe.listComplete(ctx, "purchaseOrder", { filters: [{ field: "status", op: "in", value: ["approved", "partial"] }] }),
    qe.listComplete(ctx, "stockTransfer", { filters: [{ field: "status", op: "eq", value: "in_transit" }] }),
    qe.listComplete(ctx, "stockCount", { filters: [{ field: "status", op: "eq", value: "posted" }] }),
    qe.listComplete(ctx, "posSession", { filters: [{ field: "status", op: "eq", value: "closed" }] }),
    qe.listComplete(ctx, "vendorBill", {}),
  ]);
  result.scanned = orders.length + transfers.length + counts.length + sessions.length + bills.length;

  const candidates: Candidate[] = [
    ...orders.map((r) => classifyPurchaseOrder(r, ctx.at)),
    ...transfers.map((r) => classifyTransfer(r, ctx.at)),
    ...counts.map((r) => classifyCount(r)),
    ...sessions.map((r) => classifySession(r)),
    ...bills.map((r) => classifyBill(r)),
  ].filter((c): c is Candidate => c !== null);

  const open = await qe.listComplete(ctx, "operationsAlert", {
    filters: [{ field: "status", op: "eq", value: "open" }],
  });
  // Keyed by document AND kind: one document can be late and also mis-billed,
  // and those are separate problems for separate people.
  const openByKey = new Map<string, EntityRecord>();
  for (const a of open) openByKey.set(`${String(a.refType)}:${String(a.refId)}|${String(a.kind)}`, a);

  const stillTrue = new Set<string>();
  for (const c of candidates) {
    const key = `${c.refType}:${c.refId}|${c.kind}`;
    stillTrue.add(key);
    if (openByKey.has(key)) {
      result.ongoing += 1;
      continue; // already reported; saying it again is how alerts get muted
    }
    // Through the domain service, not the query engine: that is what stages the
    // outbox event, and the event is the entire point — an alert nobody is told
    // about is a report.
    await domain.create(ctx, "operationsAlert", {
      kind: c.kind,
      status: "open",
      refType: c.refType,
      refId: c.refId,
      title: c.title,
      amount: c.amount,
      threshold: c.threshold,
      branchId: c.branchId ?? null,
      detectedAt: ctx.at,
    });
    result.opened += 1;
  }

  for (const [key, alert] of openByKey) {
    if (stillTrue.has(key)) continue;
    await qe.patchComputed(ctx, "operationsAlert", String(alert.id), { status: "resolved", resolvedAt: ctx.at });
    result.resolved += 1;
  }

  logger.info("operations alerts scanned", { ...result });
  return result;
}
