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
import { BASE_CURRENCY } from "@/lib/config/env";
import { lineQtyInBase } from "@/lib/inventory/uom";
import { retryOnConflict } from "@/lib/data/optimistic";
import { applyTevkifat } from "./tevkifat";
import { docTotals, lineTotals } from "./totals";
import { numberSequence, NumberSequence } from "./number-sequence";
import { postPaymentGL } from "@/lib/accounting/postings";

export interface LineInput {
  productId?: string | null;
  description: string;
  qty: number;
  unitPrice: number;
  taxRate: number;
  /** Line discount as a percentage of gross. See `finance/totals`. */
  discountRate?: number;
  /** Absolute line discount, applied after the percentage. */
  discountAmount?: number;
  /**
   * The unit the quantity was entered in — a case, a kilo, a piece.
   *
   * Absent means the product's base unit, which is what every line written
   * before units existed means. See `inventory/uom`.
   */
  uomId?: string | null;
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
  /**
   * The till shift that took the money, when it came over a counter.
   *
   * Absent for every other kind of receipt — a bank transfer belongs to no
   * shift. It is what lets a till report split its takings by method instead of
   * into "cash" and "everything else".
   */
  sessionId?: string | null;
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

  /** Create a header document with an assigned number and zeroed totals. Extra
   *  server-derived values (e.g. a cart's denormalized creator name) may be
   *  supplied — they are written alongside the standard computed fields. */
  async createDocument(
    ctx: RequestContext,
    entity: string,
    prefix: string,
    header: Record<string, unknown>,
    extraComputed: Record<string, FieldValue> = {},
  ): Promise<EntityRecord> {
    const number = await this.seq.next(ctx.tenantId, prefix);
    const def = this.metadata.getEntity(entity);
    const computed: Record<string, FieldValue> = { number, subtotal: 0, taxTotal: 0, total: 0, ...extraComputed };
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
    const lines = await this.qe.listComplete(ctx, lineEntity, {
      filters: [{ field: parentField, op: "eq", value: docId }],
    });
    return { doc, lines };
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
    // Must see every existing line: a page would leave the remainder orphaned
    // against a document whose totals no longer account for them.
    const existing = await this.qe.listComplete(ctx, lineEntity, {
      filters: [{ field: parentField, op: "eq", value: docId }],
    });
    // One round-trip for the whole set instead of a read + delete per line: line
    // entities are never owner-scoped, so the bulk delete's `<entity>:delete`
    // check is the same gate the per-record path applied (record-level ABAC only
    // engages for an `ownerId`, which lines never carry).
    if (existing.length) {
      await this.qe.removeMany(
        ctx,
        lineEntity,
        existing.map((l) => String(l.id)),
      );
    }

    for (const line of lines) {
      const { lineTotal, lineDiscount } = lineTotals(line);
      // Resolved once, here, and STORED. The stock ledger reads `qtyBase`, so
      // the quantity that moved is a fact recorded on the line rather than
      // something re-derived at posting time from a conversion factor that may
      // have been edited in between — which would make a posting disagree with
      // the document it came from.
      const qtyBase = line.productId
        ? await lineQtyInBase(ctx, String(line.productId), line.qty, line.uomId)
        : line.qty;
      await this.qe.createWithComputed(
        ctx,
        lineEntity,
        {
          [parentField]: docId,
          productId: line.productId ?? null,
          description: line.description,
          qty: line.qty,
          uomId: line.uomId ?? null,
          unitPrice: line.unitPrice,
          discountRate: line.discountRate ?? 0,
          discountAmount: line.discountAmount ?? 0,
          taxRate: line.taxRate,
        },
        // `discountTotal` and `qtyBase` are derived, so they are written as
        // computed rather than accepted from the caller — otherwise a client
        // could state a discount that disagrees with the rate and amount beside
        // it, or a base quantity that disagrees with the unit.
        { lineTotal, discountTotal: lineDiscount, qtyBase },
      );
    }

    // The header discount is read from the document rather than passed in: it is
    // a property of the document, and recomputing totals must produce the same
    // answer whether it was triggered by a line edit or a header edit.
    const header = await this.qe.get(ctx, entity, docId);
    const totals = docTotals(lines, {
      discountRate: Number(header.discountRate ?? 0),
      discountAmount: Number(header.discountAmount ?? 0),
    });
    const computed: Record<string, FieldValue> = { ...totals };
    const def = this.metadata.getEntity(entity);

    // KDV tevkifatı: when the buyer withholds part of the VAT, the document
    // total is the base plus only the collectible share. Read the ratio off the
    // document — it is a header choice, not a per-line one.
    let documentTotal = totals.total;
    if (def.fields.some((f) => f.name === "tevkifatRatio")) {
      const ratio = Number(header.tevkifatRatio ?? 0);
      const split = applyTevkifat(totals.subtotal, totals.taxTotal, ratio);
      computed.tevkifatTotal = split.withheld;
      documentTotal = split.documentTotal;
      computed.total = documentTotal;
    }

    if (def.fields.some((f) => f.name === "balance")) {
      const current = await this.qe.get(ctx, entity, docId);
      const amountPaid = typeof current.amountPaid === "number" ? current.amountPaid : 0;
      computed.balance = round2(documentTotal - amountPaid);
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
    // The invoice's paid total is derived from these, so a page would misstate
    // the balance rather than merely shorten a list.
    return this.qe.listComplete(ctx, "payment", {
      filters: [{ field: "invoiceId", op: "eq", value: invoiceId }],
      sort: [{ field: "paidAt", dir: "asc" }],
    });
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
      throw new BadRequestError(`payment ${round2(input.amount)} exceeds the outstanding balance ${balance}`).withKey("err.paymentExceedsBalance", { amount: round2(input.amount), balance });
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
          sessionId: input.sessionId ?? null,
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

  /**
   * Turn an opportunity into a draft quote.
   *
   * The missing first link. The chain ran `quote → invoice → payment`, with the
   * pipeline sitting beside it unconnected: a deal was worked to `proposal` and
   * whatever went to the customer was a separate document nobody could trace
   * back to it.
   *
   * A deal has no lines, only an `amount` — a salesperson's estimate of what the
   * opportunity is worth. So one line is seeded from it, described by the deal's
   * own name, and the quote is where that estimate becomes an itemised offer.
   * Seeding the amount rather than leaving the quote empty is the difference
   * between a starting point and a blank form.
   *
   * The deal's stage is NOT advanced. Converting is not the same as having
   * proposed — the quote is still a draft that nobody has sent — and moving
   * somebody's pipeline underneath them as a side effect of pressing a button
   * labelled "create quote" is the kind of helpfulness that gets undone by hand.
   * `deal:update` is also a separate grant, so it could fail after the quote was
   * already written.
   */
  async convertDealToQuote(ctx: RequestContext, dealId: string): Promise<string> {
    const deal = await this.qe.get(ctx, "deal", dealId);
    // A quote is addressed to somebody. A deal without an account is still an
    // idea, and inventing a customer for it would be worse than refusing.
    if (!deal.accountId) {
      throw new BadRequestError("this deal has no customer; set one before creating a quote");
    }
    const issueDate = ctx.at.slice(0, 10);
    // "Q", the same series a directly-raised quote draws from. A separate
    // prefix would split the numbering in two and make "quote 14" ambiguous.
    const quote = await this.createDocument(ctx, "quote", "Q", {
      accountId: String(deal.accountId),
      dealId,
      currencyCode: BASE_CURRENCY,
      validUntil: addDays(issueDate, 30),
      status: "draft",
      branchId: deal.branchId ?? null,
      dealerId: deal.dealerId ?? null,
    });
    const amount = Number(deal.amount ?? 0);
    await this.replaceLines(ctx, "quote", "quoteLine", "quoteId", quote.id, [
      {
        productId: null,
        description: String(deal.name ?? "Opportunity"),
        qty: 1,
        unitPrice: amount > 0 ? amount : 0,
        taxRate: 0,
      },
    ]);
    return quote.id;
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
    // Every active plan must run: a page would silently stop billing whichever
    // customers happened to fall past the cap.
    const plans = await this.qe.listComplete(ctx, "recurringPlan", {
      filters: [{ field: "active", op: "eq", value: true }],
    });
    const generated: string[] = [];
    for (const plan of plans) {
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

  /**
   * Flag sent/partial invoices past their due date as overdue.
   *
   * Streams rather than reading a page: the invoice table only ever grows, and
   * a nightly job that stops looking after N rows leaves the oldest unpaid
   * invoices — precisely the ones that matter — permanently un-flagged.
   *
   * Paging while writing is safe *here* because the query is unfiltered and the
   * default order (`createdAt DESC, id ASC`) is over immutable columns, so a row
   * this loop updates neither moves between pages nor drops out of the set. Do
   * not "optimise" this by filtering on `status` — rows would leave the result
   * set as they were flagged and every subsequent page would skip that many.
   */
  async markOverdue(ctx: RequestContext, today = ctx.at.slice(0, 10)): Promise<number> {
    let count = 0;
    await this.qe.listAll(ctx, "invoice", {}, async (invoices) => {
      for (const inv of invoices) {
        const status = String(inv.status);
        const balance = typeof inv.balance === "number" ? inv.balance : 0;
        if ((status === "sent" || status === "partial") && balance > 0 && inv.dueDate && String(inv.dueDate) < today) {
          await this.qe.patchComputed(ctx, "invoice", inv.id, { status: "overdue" });
          count++;
        }
      }
    });
    return count;
  }
}

const globalRef = globalThis as unknown as { __aulaFinance?: FinanceService };

export async function getFinanceService(): Promise<FinanceService> {
  const qe = await getQueryEngine();
  globalRef.__aulaFinance ??= new FinanceService(qe, metadata, numberSequence);
  return globalRef.__aulaFinance;
}
