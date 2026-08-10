/**
 * Perpetual moving weighted-average costing — the arithmetic, as pure functions.
 *
 * ## Why moving average rather than FIFO layers
 *
 * VUK md. 274/275 accepts FIFO and weighted average (not LIFO), and every
 * mainstream Turkish ERP — Logo, Mikro, Netsis — defaults to *hareketli
 * ağırlıklı ortalama*. That is the method an accountant will reconcile against.
 * It also suits the traffic: a 20-line POS sale is one locked UPDATE per line
 * here, versus an ordered scan of open layers plus k partial-consumption writes
 * per line under FIFO. And FIFO's multi-row consumption cannot be expressed
 * through the metadata-driven query engine, so it would mean hand-written SQL in
 * a service.
 *
 * The trade-offs, stated plainly: there is no per-lot cost traceability, and a
 * back-dated receipt does not retroactively restate earlier COGS (inherent to a
 * perpetual average, and what Logo/Mikro do). `stockMovement.unitCost` still
 * records the cost each movement applied, so "last purchase cost" stays
 * derivable, and adding lots later means a third component in the balance key
 * rather than a rewrite.
 *
 * ## Why no stored average
 *
 * The obvious model keeps `avgCost` on the balance row and computes issue cost
 * as `qty × avgCost`. Don't: `currency` maps to DECIMAL(18,2), so a 2-decimal
 * unit cost is wrong for cheap or bulk items, and a stored average drifts from
 * `value` after repeated rounding. That drift is precisely the reported bug —
 * an Inventory account left non-zero with no units on hand.
 *
 * Consuming proportionally instead:
 *
 *     issueValue = round2(value × q / qty)
 *
 * is algebraically the same number but self-correcting: the residual is always
 * exact, so **qty → 0 implies value → 0 to the cent**. That single property is
 * what keeps the Inventory account tied to the stock it represents.
 */

/**
 * Round to cents, normalising negative zero away.
 *
 * `Math.round(-0.001)` is `-0`, which survives into JSON as `-0` and compares
 * unequal to `0` under `Object.is`. Adding zero collapses it, so a movement that
 * moved no value records `0` rather than `-0`.
 */
export const round2 = (n: number): number => Math.round(n * 100) / 100 + 0;

/** The part of a balance row costing depends on. */
export interface BalanceState {
  qty: number;
  value: number;
}

export interface CostingResult {
  newQty: number;
  newValue: number;
  /** Signed change in inventory value — feed this straight to the GL. */
  valueDelta: number;
  /** Cost per unit actually applied, for reporting. `valueDelta` is authoritative. */
  appliedUnitCost: number;
}

/** Average unit cost for display; never an input to `applyOutbound`. */
export function avgCostOf(bal: BalanceState): number {
  return bal.qty > 0 ? round2(bal.value / bal.qty) : 0;
}

/**
 * Goods in: a receipt, a transfer-in, or a positive adjustment.
 *
 * `unitCost` is the cost being brought in (the GRN's price, the transfer's
 * derived cost). Quantity and value both rise; the new average falls out of the
 * new totals rather than being computed and stored.
 *
 * When on-hand is negative — stock issued before its receipt was recorded — the
 * incoming units still land at their own cost. The balance's value may briefly
 * be negative; the next issue consumes proportionally from whatever is there,
 * and the invariant (qty → 0 ⟹ value → 0) still holds once quantity returns to
 * zero.
 */
export function applyInbound(bal: BalanceState, qty: number, unitCost: number): CostingResult {
  if (qty <= 0) throw new Error(`applyInbound requires a positive quantity, got ${qty}`);
  const valueDelta = round2(qty * unitCost);
  return {
    newQty: round2(bal.qty + qty),
    newValue: round2(bal.value + valueDelta),
    valueDelta,
    appliedUnitCost: round2(unitCost),
  };
}

/**
 * Goods out: an issue, a transfer-out, or a negative adjustment.
 *
 * Cost is never taken from the product master — it is the proportional share of
 * the value actually sitting in this balance. Reading `product.costPrice` at
 * posting time is what let the Inventory account drift whenever purchase prices
 * moved: goods came in at the receipt cost and went out at whatever the product
 * card happened to say.
 *
 * Consuming the *whole* balance takes the whole value exactly, with no residual
 * rounding — the property that keeps the account honest.
 *
 * Issuing more than is on hand (only reachable when negative stock is allowed)
 * charges the excess at the current average, or at zero when there is nothing to
 * average. That is a best effort: the true cost is not knowable until the
 * missing receipt is recorded.
 */
export function applyOutbound(bal: BalanceState, qty: number): CostingResult {
  if (qty <= 0) throw new Error(`applyOutbound requires a positive quantity, got ${qty}`);

  let consumed: number;
  if (bal.qty <= 0) {
    // Nothing on hand to apportion — no basis for a cost.
    consumed = 0;
  } else if (qty >= bal.qty) {
    // Taking everything: take exactly the whole value, leaving zero.
    consumed = round2(bal.value);
  } else {
    consumed = round2((bal.value * qty) / bal.qty);
  }

  return {
    newQty: round2(bal.qty - qty),
    newValue: round2(bal.value - consumed),
    // round2 rather than a bare `-consumed`, so consuming nothing yields 0 and
    // not -0 (which JSON preserves and Object.is treats as a different value).
    valueDelta: round2(-consumed),
    appliedUnitCost: qty > 0 ? round2(consumed / qty) : 0,
  };
}
