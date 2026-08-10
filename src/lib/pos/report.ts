/**
 * The till report — X and Z.
 *
 * The same figures read at two different moments, which is why there is one
 * function and not two: an X-report is a mid-shift read that changes nothing,
 * and a Z-report is the same read taken at closing. Writing them separately is
 * how the two come to disagree, and the entire purpose of an X-report is that
 * the cashier can trust it to match the Z that follows.
 *
 * What the session row could not answer, and this does:
 *
 *  - **Where the money is.** The session tracks cash, because the drawer needs a
 *    running figure under concurrency. Everything else — card, voucher, on
 *    account — collapsed into "not cash", so a cashier balancing the till had no
 *    card total to compare against the terminal's own printout.
 *  - **What is not a sale.** A float top-up or a courier paid from the drawer
 *    used to surface as a variance. A variance that is routinely wrong is a
 *    control nobody reads.
 *  - **The tax.** Required to be reportable per rate, and nowhere to be found.
 *
 * The breakdown is AGGREGATED, not stored. A denormalised set of per-method
 * totals on the session is a second copy of the payments that has to be kept in
 * step with them, and the moment a payment is voided the two disagree with
 * nothing to say which is right.
 */
import type { EntityRecord } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import { retryOnConflict } from "@/lib/data/optimistic";
import { lineTotals } from "@/lib/finance/totals";
import { BadRequestError, ConflictError } from "@/lib/enforcement/errors";

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface TenderLine {
  method: string;
  amount: number;
  count: number;
}

export interface TaxLine {
  /** The KDV rate, as a percentage. */
  rate: number;
  /** The taxable base at that rate — the matrah. */
  base: number;
  tax: number;
}

export interface SessionReport {
  kind: "x" | "z";
  session: EntityRecord;
  /** Sales rung up in this shift. Voided ones are excluded and counted apart. */
  saleCount: number;
  salesTotal: number;
  salesSubtotal: number;
  taxTotal: number;
  /** Sales rung up and then voided — a number worth seeing on its own. */
  voidCount: number;
  voidTotal: number;
  tenders: TenderLine[];
  taxes: TaxLine[];
  paidIn: number;
  paidOut: number;
  movements: EntityRecord[];
  openingFloat: number;
  /** What should be in the drawer: float + cash taken + paid in − paid out. */
  expectedCash: number;
  /** Only meaningful once counted; zero on an X-report. */
  countedCash: number;
  variance: number;
}

/**
 * Build the report for a session.
 *
 * `kind` labels the output and nothing else — the arithmetic is identical, which
 * is the property that makes an X-report worth trusting.
 */
export async function sessionReport(
  ctx: RequestContext,
  sessionId: string,
  kind: "x" | "z" = "x",
): Promise<SessionReport> {
  const qe = await getQueryEngine();
  const session = await qe.get(ctx, "posSession", sessionId);

  const [invoices, payments, movements] = await Promise.all([
    qe.listComplete(ctx, "invoice", { filters: [{ field: "sessionId", op: "eq", value: sessionId }] }),
    qe.listComplete(ctx, "payment", { filters: [{ field: "sessionId", op: "eq", value: sessionId }] }),
    qe.listComplete(ctx, "posMovement", { filters: [{ field: "sessionId", op: "eq", value: sessionId }] }),
  ]);

  // A voided sale is not a sale. It is also not nothing: a shift with fourteen
  // voids is a different shift from one with none, whatever the totals say.
  const live = invoices.filter((i) => String(i.status) !== "void");
  const voided = invoices.filter((i) => String(i.status) === "void");

  const salesTotal = round2(live.reduce((t, i) => t + Number(i.total ?? 0), 0));
  const salesSubtotal = round2(live.reduce((t, i) => t + Number(i.subtotal ?? 0), 0));
  const taxTotal = round2(live.reduce((t, i) => t + Number(i.taxTotal ?? 0), 0));

  // Tenders, by method. Payments against a voided sale are excluded — the money
  // went back to the customer.
  const liveIds = new Set(live.map((i) => String(i.id)));
  const byMethod = new Map<string, { amount: number; count: number }>();
  for (const p of payments) {
    if (p.invoiceId && !liveIds.has(String(p.invoiceId))) continue;
    const method = String(p.method ?? "other");
    const entry = byMethod.get(method) ?? { amount: 0, count: 0 };
    entry.amount = round2(entry.amount + Number(p.amount ?? 0));
    entry.count += 1;
    byMethod.set(method, entry);
  }
  const tenders: TenderLine[] = [...byMethod.entries()]
    .map(([method, v]) => ({ method, amount: v.amount, count: v.count }))
    .sort((a, b) => b.amount - a.amount);

  // KDV per rate, from the lines rather than the headers: a sale can mix a 1%
  // staple with a 20% item, and a header total cannot be split back apart.
  const lines = live.length
    ? await qe.listComplete(ctx, "invoiceLine", {
        filters: [{ field: "invoiceId", op: "in", value: live.map((i) => String(i.id)) }],
      })
    : [];
  const byRate = new Map<number, { base: number; tax: number }>();
  for (const l of lines) {
    const rate = Number(l.taxRate ?? 0);
    // Recomputed with the SAME function the document used, rather than derived
    // from the stored `lineTotal` — which is the GROSS figure, tax included.
    // Dividing that back out by the rate would be a second, independent
    // calculation of the same number, and the two would disagree the moment a
    // discount rounded.
    const { lineSubtotal, lineTax } = lineTotals({
      qty: Number(l.qty ?? 0),
      unitPrice: Number(l.unitPrice ?? 0),
      taxRate: rate,
      discountRate: Number(l.discountRate ?? 0),
      discountAmount: Number(l.discountAmount ?? 0),
    });
    const entry = byRate.get(rate) ?? { base: 0, tax: 0 };
    entry.base = round2(entry.base + lineSubtotal);
    entry.tax = round2(entry.tax + lineTax);
    byRate.set(rate, entry);
  }
  const taxes: TaxLine[] = [...byRate.entries()]
    .map(([rate, v]) => ({ rate, base: v.base, tax: round2(v.tax) }))
    .sort((a, b) => a.rate - b.rate);

  const paidIn = round2(
    movements.filter((m) => String(m.direction) === "in").reduce((t, m) => t + Number(m.amount ?? 0), 0),
  );
  const paidOut = round2(
    movements.filter((m) => String(m.direction) === "out").reduce((t, m) => t + Number(m.amount ?? 0), 0),
  );

  const openingFloat = round2(Number(session.openingFloat ?? 0));
  // The session's own running `cashTotal`, not a re-sum of the cash tenders.
  //
  // The two agree today — `applyPayment` refuses to record more than the
  // outstanding balance, so a 200 tender against a 120 sale writes a payment of
  // 120 and the change never becomes a row. But the drawer figure is the one the
  // till accrues under a version guard as each sale completes, and deriving the
  // expected cash from a second source would mean the two could ever disagree.
  const cashTaken = round2(Number(session.cashTotal ?? 0));
  const expectedCash = round2(openingFloat + cashTaken + paidIn - paidOut);
  const countedCash = round2(Number(session.countedCash ?? 0));

  return {
    kind,
    session,
    saleCount: live.length,
    salesTotal,
    salesSubtotal,
    taxTotal,
    voidCount: voided.length,
    voidTotal: round2(voided.reduce((t, i) => t + Number(i.total ?? 0), 0)),
    tenders,
    taxes,
    paidIn,
    paidOut,
    movements: [...movements].sort((a, b) =>
      String(a.occurredAt ?? "") < String(b.occurredAt ?? "") ? -1 : 1,
    ),
    openingFloat,
    expectedCash,
    // An X-report is taken mid-shift: nothing has been counted, and printing a
    // variance against a zero count would read as the till being empty.
    countedCash: kind === "z" ? countedCash : 0,
    variance: kind === "z" ? round2(countedCash - expectedCash) : 0,
  };
}

export interface MovementInput {
  direction: "in" | "out";
  amount: number;
  reason: string;
  notes?: string | null;
}

/**
 * Record money into or out of the drawer.
 *
 * Also folds the amount into the session's `expectedCash`, under the same
 * version guard the sale accrual uses: the expected figure has to move when the
 * cash does, or the next X-report reports a variance that is really a float
 * top-up.
 */
export async function recordMovement(
  ctx: RequestContext,
  sessionId: string,
  input: MovementInput,
): Promise<EntityRecord> {
  const qe = await getQueryEngine();
  const session = await qe.get(ctx, "posSession", sessionId);
  if (String(session.status) !== "open") {
    throw new ConflictError("the till is closed — reopen a session before moving cash");
  }
  const amount = round2(Math.abs(Number(input.amount)));
  if (!(amount > 0)) throw new BadRequestError("a cash movement must be for a positive amount");

  const movement = await qe.create(ctx, "posMovement", {
    sessionId,
    direction: input.direction,
    amount,
    reason: input.reason,
    userId: ctx.userId,
    occurredAt: ctx.at,
    notes: input.notes ?? null,
  });

  await retryOnConflict(async () => {
    const fresh = await qe.get(ctx, "posSession", sessionId);
    const delta = input.direction === "in" ? amount : -amount;
    await qe.patchComputed(
      ctx,
      "posSession",
      sessionId,
      { expectedCash: round2(Number(fresh.expectedCash ?? 0) + delta) },
      Number(fresh.version),
    );
  });

  return movement;
}
