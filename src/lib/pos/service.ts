import { BASE_CURRENCY } from "@/lib/config/env";
/**
 * Point-of-sale service — orchestrates an over-the-counter sale on top of the
 * existing finance/accounting/inventory machinery so POS reuses (not duplicates)
 * the GL + stock logic:
 *   create invoice (draft) → replace lines → `send` transition (posts AR/Revenue
 *   /COGS + issues stock from the chosen warehouse) → apply tender as payments.
 *
 * The orchestration runs under an elevated system context (preserving the
 * cashier as actor) — like the inventory + chat services — so a cashier only
 * needs the `pos:checkout` grant rather than broad invoice/payment grants. The
 * endpoint is the controlled gateway.
 */
import type { EntityRecord } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import { systemContext } from "@/lib/context/resolver";
import { getQueryEngine } from "@/lib/data/store";
import type { QueryEngine } from "@/lib/data/query-engine";
import { numberSequence, NumberSequence } from "@/lib/finance/number-sequence";
import { getFinanceService, type FinanceService, type LineInput } from "@/lib/finance/service";
import { getDomainService } from "@/lib/domain";
import { barcodeCandidates } from "@/lib/barcode/check-digit";
import { BadRequestError } from "@/lib/enforcement/errors";
import { retryOnConflict } from "@/lib/data/optimistic";

export interface PosLine {
  productId?: string | null;
  description?: string;
  qty: number;
  unitPrice: number;
  /** Discount rung up at the till. Requires `pos:discount` — checked at the route. */
  discountRate?: number;
  discountAmount?: number;
  taxRate: number;
  /**
   * The unit the quantity is in — a case, a six-pack.
   *
   * Set when the cashier scanned a pack barcode rather than the item's own. Null
   * means the base unit, which is every sale rung up before pack codes existed.
   */
  uomId?: string | null;
}
export interface PosPayment {
  method: string;
  amount: number;
}
export interface PosCheckoutInput {
  branchId?: string | null;
  warehouseId?: string | null;
  dealerId?: string | null;
  accountId?: string | null;
  sessionId?: string | null;
  currencyCode?: string;
  /** Basket-level discount, apportioned across the lines. */
  discountRate?: number;
  discountAmount?: number;
  lines: PosLine[];
  payments: PosPayment[];
  /** Client-supplied dedupe token: a double-submit (same key) returns the first
   *  sale's result instead of ringing up a second invoice. */
  idempotencyKey?: string | null;
}
export interface PosSessionInput {
  branchId?: string | null;
  warehouseId?: string | null;
  openingFloat?: number;
}
export interface PosCheckoutResult {
  invoice: EntityRecord;
  lines: EntityRecord[];
  total: number;
  paid: number;
  change: number;
}

/** A scan resolved to a product and to what one of that code actually is. */
export interface ScanResult {
  product: EntityRecord;
  /**
   * The unit one scan represents — a case, a six-pack — or null for the base
   * unit. Handed to the caller rather than converted here: the till puts it on
   * the LINE, and `replaceLines` is the single place that converts a line's unit
   * into base units for the ledger.
   */
  uomId: string | null;
  /** How many of that unit one scan is. One, until a code means "a dozen of". */
  qty: number;
  /** The alias row that matched, when it was not the primary barcode. */
  barcode?: EntityRecord;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The default cash-sale customer used when no account/dealer is chosen. */
export const WALK_IN_ACCOUNT_NAME = "Walk-in Customer";

export class PosService {
  /** In-flight + recently-completed checkouts, keyed by tenant+idempotency token,
   *  so a double-submit collapses onto the first sale instead of duplicating it. */
  private readonly inflight = new Map<string, Promise<PosCheckoutResult>>();

  constructor(
    private readonly qe: QueryEngine,
    private readonly finance: FinanceService,
    private readonly seq: NumberSequence,
  ) {}

  private sys(ctx: RequestContext): RequestContext {
    return systemContext(ctx.tenantId, ctx.orgId, { userId: ctx.userId, displayName: ctx.displayName, email: ctx.email });
  }

  /** Idempotent entry point: dedupe by `idempotencyKey`, then ring the sale. A
   *  duplicate that arrives while the first is in-flight (or within ~60s after)
   *  receives the same result; a failed attempt is dropped so a retry can proceed. */
  async checkout(ctx: RequestContext, input: PosCheckoutInput): Promise<PosCheckoutResult> {
    const key = input.idempotencyKey ? `${ctx.tenantId}:${ctx.orgId}:${input.idempotencyKey}` : null;
    if (!key) return this.checkoutInner(ctx, input);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.checkoutInner(ctx, input);
    this.inflight.set(key, p);
    p.then(
      () => {
        const timer = setTimeout(() => this.inflight.delete(key), 60_000);
        timer.unref?.();
      },
      () => this.inflight.delete(key), // failed sale: allow a genuine retry
    );
    return p;
  }

  /** Resolve a product by barcode (matching every equivalent symbology form of
   *  the scan — UPC-A/EAN-13/UPC-E), then by SKU. Returns null if not found. */
  async lookup(ctx: RequestContext, code: string): Promise<EntityRecord | null> {
    return (await this.scan(ctx, code))?.product ?? null;
  }

  /**
   * Resolve a scan to a product AND what one scan of that code means.
   *
   * A product has more than one barcode: the bottle, the six-pack and the case
   * each carry their own, and they are not the same quantity. Returning only the
   * product loses that — the case gets rung up as one bottle, and the shelf and
   * the ledger part company by eleven.
   *
   * Order matters. The product's primary barcode is tried first because it is
   * what every existing row carries and what the label designer prints; the
   * alias table is searched after it, and the SKU last.
   */
  async scan(ctx: RequestContext, code: string): Promise<ScanResult | null> {
    const candidates = barcodeCandidates(code);
    if (!candidates.length) return null;

    const byBarcode = await this.qe.list(ctx, "product", {
      filters: [{ field: "barcode", op: "in", value: candidates }],
      pageSize: 1,
    });
    // The primary barcode is always one base unit — that is what it has always
    // meant, and re-interpreting it now would change the quantity of every scan
    // already in use.
    if (byBarcode.items[0]) return { product: byBarcode.items[0], uomId: null, qty: 1 };

    const alias = await this.qe.list(ctx, "productBarcode", {
      filters: [{ field: "code", op: "in", value: candidates }],
      pageSize: 1,
    });
    const hit = alias.items[0];
    if (hit) {
      const product = await this.qe.get(ctx, "product", String(hit.productId)).catch(() => null);
      // A barcode whose product has been deleted is a dangling row, not a match.
      // Falling through to the SKU search is better than returning half an
      // answer the till would then try to price.
      if (product) return { product, uomId: hit.uomId ? String(hit.uomId) : null, qty: 1, barcode: hit };
    }

    const bySku = await this.qe.list(ctx, "product", {
      filters: [{ field: "sku", op: "eq", value: candidates[0] ?? "" }],
      pageSize: 1,
    });
    return bySku.items[0] ? { product: bySku.items[0], uomId: null, qty: 1 } : null;
  }

  private async defaultAccountId(ctx: RequestContext): Promise<string | null> {
    const page = await this.qe.list(ctx, "account", { filters: [{ field: "name", op: "eq", value: WALK_IN_ACCOUNT_NAME }], pageSize: 1 });
    if (page.items[0]) return String(page.items[0].id);
    // Self-heal: create the default cash-sale customer on first POS use (handles
    // databases provisioned before the walk-in account was seeded).
    const created = await this.qe.create(ctx, "account", { name: WALK_IN_ACCOUNT_NAME });
    return String(created.id);
  }

  /** Ring up a sale: invoice → send (GL + stock issue) → tender as payments.
   *  The whole sale is atomic: if any step fails (e.g. insufficient stock or the
   *  ledger posting), nothing is committed — no orphan invoice, stock or payment. */
  private async checkoutInner(ctx: RequestContext, input: PosCheckoutInput): Promise<PosCheckoutResult> {
    if (!input.lines?.length) throw new BadRequestError("cart is empty");
    const sys = this.sys(ctx);
    const domain = await getDomainService();
    const accountId = input.accountId ?? (await this.defaultAccountId(sys));
    const issueDate = ctx.at.slice(0, 10);

    return this.qe.runInTransaction(async () => {
      const invoice = await this.finance.createDocument(sys, "invoice", "INV", {
        // Which shift rang this. Without it a session's sales, tax and voids
        // cannot be reported at all — the till could only ever say how much
        // cash it held.
        sessionId: input.sessionId ?? null,
        accountId,
        branchId: input.branchId ?? null,
        dealerId: input.dealerId ?? null,
        warehouseId: input.warehouseId ?? null,
        currencyCode: input.currencyCode ?? BASE_CURRENCY,
        issueDate,
        dueDate: issueDate,
        status: "draft",
        // A basket-level discount, apportioned across the lines when totals are
        // computed — see `finance/totals`.
        discountRate: input.discountRate ?? 0,
        discountAmount: input.discountAmount ?? 0,
        notes: input.sessionId ? `POS sale · session ${input.sessionId}` : "POS sale",
      });

      // Prices come from the terminal, which already resolved them through
      // `/pricing/resolve` when the item was scanned. They are NOT re-resolved
      // here: the customer was shown a price and agreed to it, and silently
      // charging a different one because a list changed mid-basket is the one
      // outcome a till must never produce.
      const lineInputs: LineInput[] = input.lines.map((l) => ({
        productId: l.productId ?? null,
        description: l.description ?? "",
        qty: l.qty,
        // The unit reaches the LINE, and `replaceLines` converts it to base
        // units for the ledger — the single place that conversion happens.
        // Dropping it here is how one scanned case would leave the shelf as one
        // bottle.
        uomId: l.uomId ?? null,
        unitPrice: l.unitPrice,
        // Carried through, not dropped. A discount the cashier applied and the
        // customer was told about has to reach the document, or the receipt and
        // the invoice disagree about what was charged.
        discountRate: l.discountRate ?? 0,
        discountAmount: l.discountAmount ?? 0,
        taxRate: l.taxRate,
      }));
      await this.finance.replaceLines(sys, "invoice", "invoiceLine", "invoiceId", invoice.id, lineInputs);

      // Send: posts AR / Revenue / Tax + COGS and issues stock from warehouseId.
      await domain.transition(sys, "invoice", invoice.id, "send");

      const after = await this.qe.get(sys, "invoice", invoice.id);
      const total = round2(Number(after.total ?? 0));

      // The GL posting runs through the (failure-isolating) event bus, so verify
      // it actually landed — otherwise roll the whole sale back rather than hand
      // the cashier a receipt for an unposted invoice.
      if (total > 0) {
        const posted = await this.qe.list(sys, "journalEntry", {
          filters: [
            { field: "source", op: "eq", value: "invoice" },
            { field: "sourceRef", op: "eq", value: invoice.id },
            { field: "status", op: "eq", value: "posted" },
          ],
          pageSize: 1,
        });
        if (posted.total === 0) throw new BadRequestError("sale could not be completed (stock or ledger posting failed)");
      }

      const tendered = round2((input.payments ?? []).reduce((s, p) => s + (p.amount > 0 ? p.amount : 0), 0));
      const change = round2(Math.max(0, tendered - total));

      // Apply tender (cap the recorded payment at the balance so we never overpay
      // the AR ledger; the change is returned from the drawer, not posted).
      let paid = 0;
      let remaining = total;
      for (const p of input.payments ?? []) {
        if (p.amount <= 0 || remaining <= 0) continue;
        const applied = round2(Math.min(p.amount, remaining));
        if (applied <= 0) continue;
        await this.finance.applyPayment(sys, invoice.id, {
          amount: applied,
          method: p.method,
          paidAt: issueDate,
          // The shift that took the money, so the report can split takings by
          // method rather than into "cash" and "everything else".
          sessionId: input.sessionId ?? null,
        });
        paid = round2(paid + applied);
        remaining = round2(remaining - applied);
      }

      if (input.sessionId) await this.accumulateSession(sys, input.sessionId, total, input.payments ?? [], change);

      const doc = await this.finance.getDocument(sys, "invoice", "invoiceLine", "invoiceId", invoice.id);
      return { invoice: doc.doc, lines: doc.lines, total, paid, change };
    });
  }

  /** Fold a completed sale into the open session's running cash/sales totals.
   *  Version-guarded so two registers/checkouts on the same session can't lose
   *  each other's accruals (which would corrupt the cash-variance reconciliation). */
  private async accumulateSession(ctx: RequestContext, sessionId: string, total: number, payments: PosPayment[], change: number): Promise<void> {
    const cashPaid = round2(payments.filter((p) => p.method === "cash").reduce((s, p) => s + (p.amount > 0 ? p.amount : 0), 0));
    const cashKept = Math.max(0, round2(cashPaid - change));
    await retryOnConflict(async () => {
      const session = await this.qe.get(ctx, "posSession", sessionId).catch(() => null);
      if (!session || session.status !== "open") return;
      const salesTotal = round2(Number(session.salesTotal ?? 0) + total);
      const cashTotal = round2(Number(session.cashTotal ?? 0) + cashKept);
      const expectedCash = round2(Number(session.openingFloat ?? 0) + cashTotal);
      await this.qe.patchComputed(ctx, "posSession", sessionId, { salesTotal, cashTotal, expectedCash }, session.version);
    });
  }

  // ---- shift / till sessions ----

  async currentSession(ctx: RequestContext): Promise<EntityRecord | null> {
    const page = await this.qe.list(ctx, "posSession", {
      filters: [
        { field: "cashierId", op: "eq", value: ctx.userId },
        { field: "status", op: "eq", value: "open" },
      ],
      sort: [{ field: "openedAt", dir: "desc" }],
      pageSize: 1,
    });
    return page.items[0] ?? null;
  }

  async openSession(ctx: RequestContext, input: PosSessionInput): Promise<EntityRecord> {
    const existing = await this.currentSession(ctx);
    if (existing) return existing; // one open session per cashier
    const number = await this.seq.next(ctx.tenantId, "POS");
    const float = round2(Number(input.openingFloat ?? 0));
    return this.qe.createWithComputed(
      ctx,
      "posSession",
      {
        branchId: input.branchId ?? null,
        warehouseId: input.warehouseId ?? null,
        cashierId: ctx.userId,
        status: "open",
        openingFloat: float,
        openedAt: ctx.at,
        closedAt: null,
        countedCash: 0,
      },
      { number, salesTotal: 0, cashTotal: 0, expectedCash: float, variance: 0 },
    );
  }

  async closeSession(ctx: RequestContext, sessionId: string, countedCash: number): Promise<EntityRecord> {
    const session = await this.qe.get(ctx, "posSession", sessionId);
    if (session.status === "closed") return session;
    const expectedCash = round2(Number(session.expectedCash ?? 0));
    const counted = round2(Number(countedCash ?? 0));
    const variance = round2(counted - expectedCash);
    return this.qe.patchComputed(ctx, "posSession", sessionId, {
      status: "closed",
      closedAt: ctx.at,
      countedCash: counted,
      variance,
    });
  }
}

const globalRef = globalThis as unknown as { __aulaPos?: PosService };

export async function getPosService(): Promise<PosService> {
  const qe = await getQueryEngine();
  const finance = await getFinanceService();
  globalRef.__aulaPos ??= new PosService(qe, finance, numberSequence);
  return globalRef.__aulaPos;
}
