/**
 * Phase F4/F5 — finance document service (quotes & invoices share this).
 *
 * Handles document-number assignment, line replacement and total recomputation
 * through the enforcement-first query engine, then writes the server-computed
 * fields (number, lineTotal, subtotal/taxTotal/total) via `patchComputed` /
 * `createWithComputed`.
 */
import { metadata } from "@/lib/metadata";
import type { MetadataResolver } from "@/lib/metadata/resolver";
import type { EntityRecord, FieldValue } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import type { QueryEngine } from "@/lib/data/query-engine";
import { BadRequestError } from "@/lib/enforcement/errors";
import { retryOnConflict } from "@/lib/data/optimistic";
import { docTotals, lineTotals } from "./totals";
import { numberSequence, NumberSequence } from "./number-sequence";
import { postPaymentGL } from "@/lib/accounting/postings";

export interface LineInput {
  productId?: string | null;
  description: string;
  qty: number;
  unitPrice: number;
  taxRate: number;
}

export interface DocumentResult {
  doc: EntityRecord;
  lines: EntityRecord[];
}

export interface PaymentInput {
  amount: number;
  method: string;
  paidAt: string;
  notes?: string | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function advance(isoDate: string, frequency: string): string {
  const d = new Date(isoDate);
  if (frequency === "weekly") {
    d.setDate(d.getDate() + 7);
  } else {
    const day = d.getDate();
    if (frequency === "quarterly") d.setMonth(d.getMonth() + 3);
    else if (frequency === "yearly") d.setFullYear(d.getFullYear() + 1);
    else d.setMonth(d.getMonth() + 1); // monthly
    // Month-end clamp: a day-31 plan advanced by a month must land on the last
    // day of the target month (Jan 31 → Feb 28/29), not overflow to Mar 3.
    if (d.getDate() !== day) d.setDate(0);
  }
  return d.toISOString().slice(0, 10);
}

export class FinanceService {
  constructor(
    private readonly qe: QueryEngine,
    private readonly metadata: MetadataResolver,
    private readonly seq: NumberSequence,
  ) {}

  /** Create a header document with an assigned number and zeroed totals. */
  async createDocument(
    ctx: RequestContext,
    entity: string,
    prefix: string,
    header: Record<string, unknown>,
  ): Promise<EntityRecord> {
    const number = await this.seq.next(ctx.tenantId, prefix);
    const def = this.metadata.getEntity(entity);
    const computed: Record<string, FieldValue> = { number, subtotal: 0, taxTotal: 0, total: 0 };
    if (def.fields.some((f) => f.name === "amountPaid")) computed.amountPaid = 0;
    if (def.fields.some((f) => f.name === "balance")) computed.balance = 0;
    return this.qe.createWithComputed(ctx, entity, header, computed);
  }

  async getDocument(
    ctx: RequestContext,
    entity: string,
    lineEntity: string,
    parentField: string,
    docId: string,
  ): Promise<DocumentResult> {
    const doc = await this.qe.get(ctx, entity, docId);
    const linesPage = await this.qe.list(ctx, lineEntity, {
      filters: [{ field: parentField, op: "eq", value: docId }],
      pageSize: 200,
    });
    return { doc, lines: linesPage.items };
  }

  /** Replace all lines of a document and recompute its totals. */
  async replaceLines(
    ctx: RequestContext,
    entity: string,
    lineEntity: string,
    parentField: string,
    docId: string,
    lines: LineInput[],
  ): Promise<EntityRecord> {
    const existing = await this.qe.list(ctx, lineEntity, {
      filters: [{ field: parentField, op: "eq", value: docId }],
      pageSize: 200,
    });
    for (const l of existing.items) await this.qe.remove(ctx, lineEntity, l.id);

    for (const line of lines) {
      const { lineTotal } = lineTotals({ qty: line.qty, unitPrice: line.unitPrice, taxRate: line.taxRate });
      await this.qe.createWithComputed(
        ctx,
        lineEntity,
        {
          [parentField]: docId,
          productId: line.productId ?? null,
          description: line.description,
          qty: line.qty,
          unitPrice: line.unitPrice,
          taxRate: line.taxRate,
        },
        { lineTotal },
      );
    }

    const totals = docTotals(lines);
    const computed: Record<string, FieldValue> = { ...totals };
    const def = this.metadata.getEntity(entity);
    if (def.fields.some((f) => f.name === "balance")) {
      const current = await this.qe.get(ctx, entity, docId);
      const amountPaid = typeof current.amountPaid === "number" ? current.amountPaid : 0;
      computed.balance = round2(totals.total - amountPaid);
    }
    return this.qe.patchComputed(ctx, entity, docId, computed);
  }

  /** Update header fields (non-computed) then replace lines. */
  async saveDocument(
    ctx: RequestContext,
    entity: string,
    lineEntity: string,
    parentField: string,
    docId: string,
    header: Record<string, unknown> | undefined,
    lines: LineInput[],
  ): Promise<DocumentResult> {
    if (header && Object.keys(header).length) await this.qe.update(ctx, entity, docId, header);
    await this.replaceLines(ctx, entity, lineEntity, parentField, docId, lines);
    return this.getDocument(ctx, entity, lineEntity, parentField, docId);
  }

  // ---- invoices: payments + conversion (AR) ----

  async listPayments(ctx: RequestContext, invoiceId: string): Promise<EntityRecord[]> {
    const page = await this.qe.list(ctx, "payment", {
      filters: [{ field: "invoiceId", op: "eq", value: invoiceId }],
      sort: [{ field: "paidAt", dir: "asc" }],
      pageSize: 200,
    });
    return page.items;
  }

  /** Record a payment, post it to the GL, then recompute the invoice — atomically. */
  async applyPayment(ctx: RequestContext, invoiceId: string, input: PaymentInput): Promise<EntityRecord> {
    const invoice = await this.qe.get(ctx, "invoice", invoiceId);
    if (!(input.amount > 0)) throw new BadRequestError("payment amount must be positive");
    // Reject overpayment: the tendered amount may not exceed the open balance
    // (a small epsilon absorbs rounding). Prevents a silent negative AR balance.
    const already = round2(
      (await this.listPayments(ctx, invoiceId)).reduce((s, p) => s + (typeof p.amount === "number" ? p.amount : 0), 0),
    );
    const balance = round2(Number(invoice.total ?? 0) - already);
    if (input.amount > balance + 0.005) {
      throw new BadRequestError(`payment ${round2(input.amount)} exceeds the outstanding balance ${balance}`);
    }
    return this.qe.runInTransaction(async () => {
      const number = await this.seq.next(ctx.tenantId, "P");
      const payment = await this.qe.createWithComputed(
        ctx,
        "payment",
        {
          invoiceId,
          accountId: invoice.accountId,
          branchId: invoice.branchId ?? null,
          dealerId: invoice.dealerId ?? null,
          amount: input.amount,
          method: input.method,
          paidAt: input.paidAt,
          notes: input.notes ?? null,
        },
        { number },
      );
      // Synchronous, idempotent GL posting (Dr Cash, Cr AR).
      await postPaymentGL(ctx, payment);
      return this.recomputeInvoice(ctx, invoiceId);
    });
  }

  async recomputeInvoice(ctx: RequestContext, invoiceId: string): Promise<EntityRecord> {
    // Version-guarded read-compute-write: two concurrent payments can't clobber
    // each other's amountPaid/balance (lost update). Replays on a version race.
    return retryOnConflict(async () => {
      const invoice = await this.qe.get(ctx, "invoice", invoiceId);
      const payments = await this.listPayments(ctx, invoiceId);
      const amountPaid = round2(
        payments.reduce((s, p) => s + (typeof p.amount === "number" ? p.amount : 0), 0),
      );
      const total = typeof invoice.total === "number" ? invoice.total : 0;
      const balance = round2(total - amountPaid);
      let status = String(invoice.status);
      if (status !== "void") {
        if (balance <= 0 && total > 0) status = "paid";
        else if (amountPaid > 0) status = "partial";
      }
      return this.qe.patchComputed(ctx, "invoice", invoiceId, { amountPaid, balance, status }, invoice.version);
    });
  }

  /** Convert an accepted quote into a draft invoice (copies lines). */
  async convertQuoteToInvoice(ctx: RequestContext, quoteId: string): Promise<string> {
    const { doc: quote, lines } = await this.getDocument(ctx, "quote", "quoteLine", "quoteId", quoteId);
    const issueDate = ctx.at.slice(0, 10);
    const invoice = await this.createDocument(ctx, "invoice", "INV", {
      accountId: quote.accountId,
      quoteId,
      currencyCode: quote.currencyCode,
      issueDate,
      dueDate: addDays(issueDate, 30),
      status: "draft",
      notes: quote.notes ?? null,
    });
    const lineInputs: LineInput[] = lines.map((l) => ({
      productId: (l.productId as string) ?? null,
      description: String(l.description),
      qty: Number(l.qty),
      unitPrice: Number(l.unitPrice),
      taxRate: Number(l.taxRate),
    }));
    await this.replaceLines(ctx, "invoice", "invoiceLine", "invoiceId", invoice.id, lineInputs);
    return invoice.id;
  }

  /** Generate draft invoices for every active recurring plan due on/before `today`. */
  // One run catches a plan fully up: it emits one invoice per missed period
  // (each dated at that period) and advances `nextRun` until it passes today —
  // so a plan overdue by N cycles yields N invoices in a single run. A per-plan
  // cap guards against runaway generation from a very stale `nextRun`.
  async generateDueInvoices(ctx: RequestContext, today = ctx.at.slice(0, 10)): Promise<string[]> {
    const MAX_CATCHUP = 60; // safety cap per plan per run
    const plans = await this.qe.list(ctx, "recurringPlan", {
      filters: [{ field: "active", op: "eq", value: true }],
      pageSize: 200,
    });
    const generated: string[] = [];
    for (const plan of plans.items) {
      const startNextRun = String(plan.nextRun ?? "");
      let cursor = startNextRun;
      let cycles = 0;
      while (cursor && cursor <= today && cycles < MAX_CATCHUP) {
        const invoice = await this.createDocument(ctx, "invoice", "INV", {
          accountId: plan.accountId,
          currencyCode: plan.currencyCode,
          issueDate: cursor,
          dueDate: addDays(cursor, 30),
          status: "draft",
          notes: `Recurring: ${String(plan.name)} (${cursor})`,
        });
        await this.replaceLines(ctx, "invoice", "invoiceLine", "invoiceId", invoice.id, [
          {
            productId: null,
            description: String(plan.description),
            qty: 1,
            unitPrice: Number(plan.amount),
            taxRate: Number(plan.taxRate),
          },
        ]);
        generated.push(invoice.id);
        cursor = advance(cursor, String(plan.frequency));
        cycles++;
      }
      // Persist the rolled-forward nextRun once (only if it actually moved).
      if (cursor && cursor !== startNextRun) {
        await this.qe.update(ctx, "recurringPlan", plan.id, { nextRun: cursor });
      }
    }
    return generated;
  }

  /** Flag sent/partial invoices past their due date as overdue. */
  async markOverdue(ctx: RequestContext, today = ctx.at.slice(0, 10)): Promise<number> {
    const page = await this.qe.list(ctx, "invoice", { pageSize: 500 });
    let count = 0;
    for (const inv of page.items) {
      const status = String(inv.status);
      const balance = typeof inv.balance === "number" ? inv.balance : 0;
      if ((status === "sent" || status === "partial") && balance > 0 && inv.dueDate && String(inv.dueDate) < today) {
        await this.qe.patchComputed(ctx, "invoice", inv.id, { status: "overdue" });
        count++;
      }
    }
    return count;
  }
}

const globalRef = globalThis as unknown as { __aulaFinance?: FinanceService };

export async function getFinanceService(): Promise<FinanceService> {
  const qe = await getQueryEngine();
  globalRef.__aulaFinance ??= new FinanceService(qe, metadata, numberSequence);
  return globalRef.__aulaFinance;
}
