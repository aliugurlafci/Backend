/**
 * Accounts-payable service — vendor bills (reusing the finance document machinery
 * for header/line totals) and bill payments. Receiving a bill posts the AP entry;
 * paying posts the AP/Cash entry and recomputes amountPaid/balance/status. All
 * postings are idempotent.
 */
import type { EntityRecord } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import { systemContext } from "@/lib/context/resolver";
import { getQueryEngine } from "@/lib/data/store";
import type { QueryEngine } from "@/lib/data/query-engine";
import { numberSequence, NumberSequence } from "@/lib/finance/number-sequence";
import { getFinanceService, type FinanceService, type LineInput, type DocumentResult } from "@/lib/finance/service";
import { postVendorBillGL, postBillPaymentGL } from "@/lib/accounting/postings";

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface BillPaymentInput {
  amount: number;
  method: string;
  paidAt: string;
  notes?: string | null;
}

export class PayablesService {
  constructor(
    private readonly qe: QueryEngine,
    private readonly finance: FinanceService,
    private readonly seq: NumberSequence,
  ) {}

  private sys(ctx: RequestContext): RequestContext {
    return systemContext(ctx.tenantId, ctx.orgId, { userId: ctx.userId, displayName: ctx.displayName, email: ctx.email });
  }

  async createBill(ctx: RequestContext, header: Record<string, unknown>, lines: LineInput[]): Promise<DocumentResult> {
    const bill = await this.finance.createDocument(ctx, "vendorBill", "BILL", { status: "draft", ...header });
    if (lines.length) await this.finance.replaceLines(ctx, "vendorBill", "vendorBillLine", "billId", bill.id, lines);
    return this.finance.getDocument(ctx, "vendorBill", "vendorBillLine", "billId", bill.id);
  }

  async getBill(ctx: RequestContext, billId: string): Promise<DocumentResult> {
    return this.finance.getDocument(ctx, "vendorBill", "vendorBillLine", "billId", billId);
  }

  async saveBill(ctx: RequestContext, billId: string, header: Record<string, unknown> | undefined, lines: LineInput[]): Promise<DocumentResult> {
    return this.finance.saveDocument(ctx, "vendorBill", "vendorBillLine", "billId", billId, header, lines);
  }

  /** Receive a bill: post the AP entry, set status received. */
  async receiveBill(ctx: RequestContext, billId: string): Promise<EntityRecord> {
    const sys = this.sys(ctx);
    const bill = await this.qe.get(sys, "vendorBill", billId);
    if (bill.status !== "draft") return bill;
    await postVendorBillGL(sys, bill);
    return this.qe.patchComputed(sys, "vendorBill", billId, { status: "received" });
  }

  async listBillPayments(ctx: RequestContext, billId: string): Promise<EntityRecord[]> {
    const page = await this.qe.list(ctx, "billPayment", {
      filters: [{ field: "billId", op: "eq", value: billId }],
      sort: [{ field: "paidAt", dir: "asc" }],
      pageSize: 200,
    });
    return page.items;
  }

  /** Pay a bill: record payment, post AP/Cash, recompute amountPaid/balance/status. */
  async payBill(ctx: RequestContext, billId: string, input: BillPaymentInput): Promise<EntityRecord> {
    const sys = this.sys(ctx);
    const bill = await this.qe.get(sys, "vendorBill", billId);
    const number = await this.seq.next(ctx.tenantId, "BPAY");
    const payment = await this.qe.createWithComputed(
      sys,
      "billPayment",
      {
        billId,
        supplierId: bill.supplierId,
        branchId: bill.branchId ?? null,
        amount: input.amount,
        method: input.method,
        paidAt: input.paidAt,
        notes: input.notes ?? null,
      },
      { number },
    );
    await postBillPaymentGL(sys, payment);
    return this.recomputeBill(sys, billId);
  }

  private async recomputeBill(ctx: RequestContext, billId: string): Promise<EntityRecord> {
    const bill = await this.qe.get(ctx, "vendorBill", billId);
    const payments = await this.listBillPayments(ctx, billId);
    const amountPaid = round2(payments.reduce((s, p) => s + (typeof p.amount === "number" ? p.amount : 0), 0));
    const total = Number(bill.total ?? 0);
    const balance = round2(total - amountPaid);
    let status = String(bill.status);
    if (status !== "void") {
      if (balance <= 0 && total > 0) status = "paid";
      else if (amountPaid > 0) status = "partial";
    }
    return this.qe.patchComputed(ctx, "vendorBill", billId, { amountPaid, balance, status });
  }
}

const globalRef = globalThis as unknown as { __aulaPayables?: PayablesService };

export async function getPayablesService(): Promise<PayablesService> {
  const qe = await getQueryEngine();
  const finance = await getFinanceService();
  globalRef.__aulaPayables ??= new PayablesService(qe, finance, numberSequence);
  return globalRef.__aulaPayables;
}
