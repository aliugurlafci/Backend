/**
 * Collapsing a document's lines into one stock movement per stock key.
 *
 * `writeMovement` is idempotent on `(ref, refType, product, warehouse, type)` —
 * that is what makes re-posting a document safe. But it means a DOCUMENT cannot
 * produce two movements with the same key: the second one matches the first and
 * is returned as a duplicate, so its quantity never reaches the ledger.
 *
 * A document with the same product on two lines is completely ordinary:
 *
 *  - an invoice quoting the same item at two prices (one discounted, one not),
 *  - a receipt taking the same item against two purchase-order lines,
 *  - a delivery filling two order lines of the same product.
 *
 * In every one of those the second line was silently dropped from the stock
 * ledger while the document total still counted it — goods left the building
 * and the balance said they were still there.
 *
 * Collapsing before writing is the fix, rather than widening the idempotency key
 * to include a line id. Nothing is lost: the moving average is a property of
 * `(product, warehouse)`, not of a line, so one movement of eight and two
 * movements of three and five apply exactly the same value. Per-line quantities
 * are already tracked on the lines themselves (`qtyReceived`, `qtyShipped`),
 * which is where they belong — the ledger's job is what moved, not which row of
 * paper asked for it.
 *
 * Pure, and separate from the service, so the arithmetic can be tested without a
 * database and cannot drift between the callers that use it.
 */

export interface MovementLine {
  productId: string;
  warehouseId: string;
  /**
   * The batch, for a lot-tracked product.
   *
   * Part of the identity, not a label: two lines of the same product from
   * different batches are different stock with different dates, different
   * traceability and their own balances. Collapsing them would merge two
   * batches into one and make a recall find the wrong goods.
   */
  lotId?: string | null;
  /** Base units, signed the same way the movement will be. */
  qtyBase: number;
  /** Inbound only. Ignored on issues, whose cost is the balance average. */
  unitCost?: number | null;
}

export interface CollapsedLine {
  productId: string;
  warehouseId: string;
  lotId: string | null;
  qtyBase: number;
  /**
   * Quantity-weighted, and deliberately NOT rounded.
   *
   * `applyInbound` computes the value as `round2(qty × unitCost)`, so rounding
   * here first and multiplying second loses money: ten at 60 plus five at 80 is
   * 1000, but `round2(1000/15) × 15` is 1000.05 — five kuruş of stock created
   * out of a rounding step. Rounding once, at the end, is the only order that
   * preserves the total.
   *
   * The stored `unitCost` column is DECIMAL(18,2) and will show 66.67; the
   * movement's `value` carries the exact figure, and that is what the balance
   * and every reversal read.
   */
  unitCost: number;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/**
 * One entry per `(product, warehouse)`, quantities summed and costs weighted.
 *
 * Sorted by product so callers take balance locks in a stable order — a
 * deadlock between two concurrent postings is a throughput problem rather than
 * a correctness one, but it costs nothing to avoid.
 *
 * Zero-quantity lines are dropped: they add nothing to the balance, and a
 * movement of zero is a row that reconciliation has to explain.
 */
export function collapseMovementLines(lines: readonly MovementLine[]): CollapsedLine[] {
  const byKey = new Map<
    string,
    { productId: string; warehouseId: string; lotId: string | null; qty: number; value: number }
  >();

  for (const line of lines) {
    if (!line.productId || !line.warehouseId) continue;
    const qty = Number(line.qtyBase);
    if (!Number.isFinite(qty) || qty === 0) continue;
    const lotId = line.lotId ?? null;
    const key = `${line.productId}::${line.warehouseId}::${lotId ?? ""}`;
    const entry = byKey.get(key) ?? {
      productId: line.productId,
      warehouseId: line.warehouseId,
      lotId,
      qty: 0,
      value: 0,
    };
    entry.qty = round4(entry.qty + qty);
    // Weighted by quantity, which is what keeps the collapsed cost honest: two
    // lines of 5 at 10 and 5 at 12 must add 110, not 5 × 11 rounded twice.
    entry.value += qty * Number(line.unitCost ?? 0);
    byKey.set(key, entry);
  }

  return [...byKey.values()]
    .filter((e) => e.qty !== 0)
    .map((e) => ({
      productId: e.productId,
      warehouseId: e.warehouseId,
      lotId: e.lotId,
      qtyBase: e.qty,
      unitCost: e.value / e.qty,
    }))
    .sort(
      (a, b) =>
        a.productId.localeCompare(b.productId) ||
        a.warehouseId.localeCompare(b.warehouseId) ||
        (a.lotId ?? "").localeCompare(b.lotId ?? ""),
    );
}
