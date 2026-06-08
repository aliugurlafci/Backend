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
import { normalizeScan } from "@/lib/barcode/check-digit";
import { BadRequestError } from "@/lib/enforcement/errors";

export interface PosLine {
  productId?: string | null;
  description?: string;
  qty: number;
  unitPrice: number;
  taxRate: number;
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
  lines: PosLine[];
  payments: PosPayment[];
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

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The default cash-sale customer used when no account/dealer is chosen. */
export const WALK_IN_ACCOUNT_NAME = "Walk-in Customer";

export class PosService {
  constructor(
    private readonly qe: QueryEngine,
    private readonly finance: FinanceService,
    private readonly seq: NumberSequence,
  ) {}

  private sys(ctx: RequestContext): RequestContext {
    return systemContext(ctx.tenantId, ctx.orgId, { userId: ctx.userId, displayName: ctx.displayName, email: ctx.email });
  }

  /** Resolve a product by exact barcode, then SKU. Returns null if not found. */
  async lookup(ctx: RequestContext, code: string): Promise<EntityRecord | null> {
    const c = normalizeScan(code);
    if (!c) return null;
    const byBarcode = await this.qe.list(ctx, "product", { filters: [{ field: "barcode", op: "eq", value: c }], pageSize: 1 });
    if (byBarcode.items[0]) return byBarcode.items[0];
    const bySku = await this.qe.list(ctx, "product", { filters: [{ field: "sku", op: "eq", value: c }], pageSize: 1 });
    return bySku.items[0] ?? null;
  }

  private async defaultAccountId(ctx: RequestContext): Promise<string | null> {
    const page = await this.qe.list(ctx, "account", { filters: [{ field: "name", op: "eq", value: WALK_IN_ACCOUNT_NAME }], pageSize: 1 });
    if (page.items[0]) return String(page.items[0].id);
    // Self-heal: create the default cash-sale customer on first POS use (handles
    // databases provisioned before the walk-in account was seeded).
    const created = await this.qe.create(ctx, "account", { name: WALK_IN_ACCOUNT_NAME });
    return String(created.id);
  }

  /** Ring up a sale: invoice → send (GL + stock issue) → tender as payments. */
  async checkout(ctx: RequestContext, input: PosCheckoutInput): Promise<PosCheckoutResult> {
    if (!input.lines?.length) throw new BadRequestError("cart is empty");
    const sys = this.sys(ctx);
    const domain = await getDomainService();
    const accountId = input.accountId ?? (await this.defaultAccountId(sys));
    const issueDate = ctx.at.slice(0, 10);

    const invoice = await this.finance.createDocument(sys, "invoice", "INV", {
      accountId,
      branchId: input.branchId ?? null,
      dealerId: input.dealerId ?? null,
      warehouseId: input.warehouseId ?? null,
      currencyCode: input.currencyCode ?? "USD",
      issueDate,
      dueDate: issueDate,
      status: "draft",
      notes: input.sessionId ? `POS sale · session ${input.sessionId}` : "POS sale",
    });

    const lineInputs: LineInput[] = input.lines.map((l) => ({
      productId: l.productId ?? null,
      description: l.description ?? "",
      qty: l.qty,
      unitPrice: l.unitPrice,
      taxRate: l.taxRate,
    }));
    await this.finance.replaceLines(sys, "invoice", "invoiceLine", "invoiceId", invoice.id, lineInputs);

    // Send: posts AR / Revenue / Tax + COGS and issues stock from warehouseId.
    await domain.transition(sys, "invoice", invoice.id, "send");

    const after = await this.qe.get(sys, "invoice", invoice.id);
    const total = round2(Number(after.total ?? 0));
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
      await this.finance.applyPayment(sys, invoice.id, { amount: applied, method: p.method, paidAt: issueDate });
      paid = round2(paid + applied);
      remaining = round2(remaining - applied);
    }

    if (input.sessionId) await this.accumulateSession(sys, input.sessionId, total, input.payments ?? [], change);

    const doc = await this.finance.getDocument(sys, "invoice", "invoiceLine", "invoiceId", invoice.id);
    return { invoice: doc.doc, lines: doc.lines, total, paid, change };
  }

  /** Fold a completed sale into the open session's running cash/sales totals. */
  private async accumulateSession(ctx: RequestContext, sessionId: string, total: number, payments: PosPayment[], change: number): Promise<void> {
    const session = await this.qe.get(ctx, "posSession", sessionId).catch(() => null);
    if (!session || session.status !== "open") return;
    const cashPaid = round2(payments.filter((p) => p.method === "cash").reduce((s, p) => s + (p.amount > 0 ? p.amount : 0), 0));
    const cashKept = Math.max(0, round2(cashPaid - change));
    const salesTotal = round2(Number(session.salesTotal ?? 0) + total);
    const cashTotal = round2(Number(session.cashTotal ?? 0) + cashKept);
    const expectedCash = round2(Number(session.openingFloat ?? 0) + cashTotal);
    await this.qe.patchComputed(ctx, "posSession", sessionId, { salesTotal, cashTotal, expectedCash });
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
