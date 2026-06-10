/**
 * Accounting service — double-entry journal posting + reporting.
 *
 * Invariants: every entry balances (Σdebit == Σcredit) before it can post; posting
 * is idempotent per (source, sourceRef); a void of a posted entry creates a
 * reversing entry rather than mutating balances. The trial balance aggregates only
 * `posted` journal lines (the flag is denormalised onto each line at post time).
 * All writes run under an elevated system context (GL is a system-owned ledger).
 */
import type { EntityRecord } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import type { Filter } from "@/lib/data/query";
import { systemContext } from "@/lib/context/resolver";
import { getQueryEngine } from "@/lib/data/store";
import type { QueryEngine } from "@/lib/data/query-engine";
import { numberSequence, NumberSequence } from "@/lib/finance/number-sequence";
import { AppError } from "@/lib/enforcement/errors";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Accounting failures are data/config errors (422) with a client-safe message —
 *  not opaque 500s — so the cause (e.g. "no ledger account…") is actually shown. */
export class AccountingError extends AppError {
  constructor(message: string) {
    super("ACCOUNTING", 422, message);
  }
}

/**
 * The standard system chart-of-accounts, keyed by the subtype the posting code
 * resolves (`requireAccount`). Used to **self-provision** a required account on
 * first use, so GL posting (goods receipts, invoices, payments…) works on a fresh
 * tenant that hasn't had the demo chart of accounts seeded — rather than failing.
 */
const STANDARD_ACCOUNTS: Record<string, { code: string; name: string; type: string; normalBalance: string }> = {
  cash: { code: "1000", name: "Cash & Bank", type: "asset", normalBalance: "debit" },
  accounts_receivable: { code: "1100", name: "Accounts Receivable", type: "asset", normalBalance: "debit" },
  inventory: { code: "1200", name: "Inventory", type: "asset", normalBalance: "debit" },
  accounts_payable: { code: "2000", name: "Accounts Payable", type: "liability", normalBalance: "credit" },
  gr_ir: { code: "2050", name: "GR/IR Clearing", type: "liability", normalBalance: "credit" },
  tax_payable: { code: "2100", name: "Tax Payable", type: "liability", normalBalance: "credit" },
  retained_earnings: { code: "3000", name: "Opening Balance Equity", type: "equity", normalBalance: "credit" },
  sales_revenue: { code: "4000", name: "Sales Revenue", type: "revenue", normalBalance: "credit" },
  cogs: { code: "5000", name: "Cost of Goods Sold", type: "expense", normalBalance: "debit" },
  operating_expense: { code: "6000", name: "Operating Expenses", type: "expense", normalBalance: "debit" },
};

export interface JournalLineInput {
  ledgerAccountId: string;
  debit?: number;
  credit?: number;
  description?: string | null;
  branchId?: string | null;
}

export interface JournalHeaderInput {
  date: string;
  memo?: string | null;
  source?: string;
  sourceRef?: string | null;
  branchId?: string | null;
}

export interface PostFromSourceInput extends JournalHeaderInput {
  source: string;
  sourceRef: string;
  lines: JournalLineInput[];
}

export interface JournalResult {
  entry: EntityRecord;
  lines: EntityRecord[];
}

export interface TrialBalanceRow {
  ledgerAccountId: string;
  debit: number;
  credit: number;
  balance: number;
}

export class AccountingService {
  constructor(
    private readonly qe: QueryEngine,
    private readonly seq: NumberSequence,
  ) {}

  private sys(ctx: RequestContext): RequestContext {
    return systemContext(ctx.tenantId, ctx.orgId, { userId: ctx.userId, displayName: ctx.displayName, email: ctx.email });
  }

  /** Enforce the double-entry invariant; returns the rounded totals. */
  assertBalanced(lines: JournalLineInput[]): { debit: number; credit: number } {
    if (!lines.length) throw new AccountingError("a journal entry needs at least one line");
    let debit = 0;
    let credit = 0;
    for (const l of lines) {
      const d = round2(l.debit ?? 0);
      const c = round2(l.credit ?? 0);
      if (d < 0 || c < 0) throw new AccountingError("debit/credit cannot be negative");
      if (d > 0 && c > 0) throw new AccountingError("a line cannot carry both a debit and a credit");
      debit += d;
      credit += c;
    }
    debit = round2(debit);
    credit = round2(credit);
    if (debit !== credit) throw new AccountingError(`unbalanced entry: debit ${debit} ≠ credit ${credit}`);
    if (debit === 0) throw new AccountingError("a journal entry cannot net to zero");
    return { debit, credit };
  }

  /** Resolve the first active account with a given subtype (e.g. "accounts_receivable"). */
  async accountBySubtype(ctx: RequestContext, subtype: string): Promise<EntityRecord | null> {
    const page = await this.qe.list(this.sys(ctx), "ledgerAccount", {
      filters: [
        { field: "subtype", op: "eq", value: subtype },
        { field: "active", op: "eq", value: true },
      ],
      pageSize: 1,
    });
    return page.items[0] ?? null;
  }

  async requireAccount(ctx: RequestContext, subtype: string): Promise<string> {
    const acc = await this.accountBySubtype(ctx, subtype);
    if (acc) return acc.id;
    // Self-heal: provision the standard account for this subtype on first use, so
    // a fresh tenant (no seeded chart of accounts) can still post the GL instead
    // of failing with "no ledger account configured".
    const def = STANDARD_ACCOUNTS[subtype];
    if (!def) throw new AccountingError(`no ledger account configured for subtype "${subtype}"`);
    const created = await this.qe.create(this.sys(ctx), "ledgerAccount", {
      code: def.code,
      name: def.name,
      type: def.type,
      subtype,
      normalBalance: def.normalBalance,
      parentId: null,
      isPostable: true,
      active: true,
    });
    return String(created.id);
  }

  /** Create a draft journal entry with balanced lines. */
  async createEntry(ctx: RequestContext, header: JournalHeaderInput, lines: JournalLineInput[]): Promise<JournalResult> {
    const totals = this.assertBalanced(lines);
    const sys = this.sys(ctx);
    const number = await this.seq.next(ctx.tenantId, "JE");
    const entry = await this.qe.createWithComputed(
      sys,
      "journalEntry",
      {
        date: header.date,
        memo: header.memo ?? null,
        source: header.source ?? "manual",
        sourceRef: header.sourceRef ?? null,
        branchId: header.branchId ?? null,
        status: "draft",
      },
      { number, debitTotal: totals.debit, creditTotal: totals.credit },
    );
    const created: EntityRecord[] = [];
    for (const l of lines) {
      created.push(
        await this.qe.create(sys, "journalLine", {
          entryId: entry.id,
          ledgerAccountId: l.ledgerAccountId,
          debit: round2(l.debit ?? 0),
          credit: round2(l.credit ?? 0),
          description: l.description ?? null,
          branchId: l.branchId ?? header.branchId ?? null,
          posted: false,
        }),
      );
    }
    return { entry, lines: created };
  }

  /** Reject posting into a closed fiscal period covering the date. */
  private async assertPeriodOpen(ctx: RequestContext, date: string): Promise<void> {
    const periods = await this.qe.list(ctx, "fiscalPeriod", {
      filters: [{ field: "status", op: "eq", value: "closed" }],
      pageSize: 200,
    });
    for (const p of periods.items) {
      if (String(p.startDate) <= date && date <= String(p.endDate)) {
        throw new AccountingError(`fiscal period "${String(p.name)}" is closed; cannot post on ${date}`);
      }
    }
  }

  /** Post a draft entry: re-assert balance + open period, flip header + lines to posted. */
  async postEntry(ctx: RequestContext, entryId: string): Promise<EntityRecord> {
    const sys = this.sys(ctx);
    const entry = await this.qe.get(sys, "journalEntry", entryId);
    if (entry.status === "posted") return entry;
    if (entry.status === "void") throw new AccountingError("cannot post a void entry");
    const linesPage = await this.qe.list(sys, "journalLine", {
      filters: [{ field: "entryId", op: "eq", value: entryId }],
      pageSize: 500,
    });
    this.assertBalanced(
      linesPage.items.map((l) => ({ ledgerAccountId: String(l.ledgerAccountId), debit: Number(l.debit ?? 0), credit: Number(l.credit ?? 0) })),
    );
    await this.assertPeriodOpen(sys, String(entry.date));
    for (const l of linesPage.items) await this.qe.patchComputed(sys, "journalLine", l.id, { posted: true });
    return this.qe.patchComputed(sys, "journalEntry", entryId, { status: "posted" });
  }

  /** Create and immediately post an entry. */
  async createAndPost(ctx: RequestContext, header: JournalHeaderInput, lines: JournalLineInput[]): Promise<EntityRecord> {
    const { entry } = await this.createEntry(ctx, header, lines);
    return this.postEntry(ctx, entry.id);
  }

  /** Idempotent posting from a sub-ledger event (skips if already posted). */
  async postFromSource(ctx: RequestContext, input: PostFromSourceInput): Promise<EntityRecord> {
    const sys = this.sys(ctx);
    const existing = await this.qe.list(sys, "journalEntry", {
      filters: [
        { field: "source", op: "eq", value: input.source },
        { field: "sourceRef", op: "eq", value: input.sourceRef },
        { field: "status", op: "eq", value: "posted" },
      ],
      pageSize: 1,
    });
    if (existing.total > 0) return existing.items[0];
    return this.createAndPost(ctx, input, input.lines);
  }

  /** Void an entry: drafts are marked void; posted entries get a reversing entry. */
  async voidEntry(ctx: RequestContext, entryId: string): Promise<EntityRecord> {
    const sys = this.sys(ctx);
    const entry = await this.qe.get(sys, "journalEntry", entryId);
    if (entry.status === "void") return entry;
    if (entry.status === "draft") return this.qe.patchComputed(sys, "journalEntry", entryId, { status: "void" });

    const linesPage = await this.qe.list(sys, "journalLine", {
      filters: [{ field: "entryId", op: "eq", value: entryId }],
      pageSize: 500,
    });
    const reversed: JournalLineInput[] = linesPage.items.map((l) => ({
      ledgerAccountId: String(l.ledgerAccountId),
      debit: Number(l.credit ?? 0),
      credit: Number(l.debit ?? 0),
      description: `Reversal of ${String(entry.number)}`,
      branchId: (l.branchId as string) ?? null,
    }));
    await this.createAndPost(sys, {
      date: sys.at.slice(0, 10),
      memo: `Reversal of ${String(entry.number)}`,
      source: "reversal",
      sourceRef: entryId,
      branchId: (entry.branchId as string) ?? null,
    }, reversed);
    return this.qe.patchComputed(sys, "journalEntry", entryId, { status: "void" });
  }

  // ---- reporting ----

  /** Trial balance from posted lines, grouped by account (optionally per branch). */
  async trialBalance(ctx: RequestContext, branchId?: string): Promise<TrialBalanceRow[]> {
    const filters: Filter[] = [{ field: "posted", op: "eq", value: true }];
    if (branchId) filters.push({ field: "branchId", op: "eq", value: branchId });
    const rows = await this.qe.aggregate(ctx, "journalLine", {
      groupBy: "ledgerAccountId",
      filters,
      measures: [
        { op: "sum", field: "debit", as: "debit" },
        { op: "sum", field: "credit", as: "credit" },
      ],
    });
    return rows
      .filter((r) => r.key)
      .map((r) => {
        const debit = round2(r.measures.debit ?? 0);
        const credit = round2(r.measures.credit ?? 0);
        return { ledgerAccountId: String(r.key), debit, credit, balance: round2(debit - credit) };
      });
  }
}

const globalRef = globalThis as unknown as { __aulaAccounting?: AccountingService };

export async function getAccountingService(): Promise<AccountingService> {
  const qe = await getQueryEngine();
  globalRef.__aulaAccounting ??= new AccountingService(qe, numberSequence);
  return globalRef.__aulaAccounting;
}
