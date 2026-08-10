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
import { dateRangeFilters, type Filter } from "@/lib/data/query";
import { systemContext } from "@/lib/context/resolver";
import { getQueryEngine } from "@/lib/data/store";
import type { QueryEngine } from "@/lib/data/query-engine";
import { numberSequence, NumberSequence } from "@/lib/finance/number-sequence";
import { AppError } from "@/lib/enforcement/errors";
import { summariseVat, type VatSummary } from "@/lib/finance/vat";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Accounting failures are data/config errors (422) with a client-safe message —
 *  not opaque 500s — so the cause (e.g. "no ledger account…") is actually shown. */
export class AccountingError extends AppError {
  constructor(message: string) {
    super("ACCOUNTING", 422, message);
  }
}

/**
 * The system chart of accounts — Turkey's **Tekdüzen Hesap Planı**.
 *
 * Keyed by the subtype the posting code resolves (`requireAccount`), and used to
 * self-provision a required account on first use, so posting works on a fresh
 * tenant rather than failing.
 *
 * The codes are the statutory ones, not an Anglo-Saxon approximation. That
 * matters concretely: the previous plan (1000 Cash, 1100 AR, 4000 Revenue…) is
 * not a chart a Turkish accountant can reconcile against or file from, so the
 * ledger was internally consistent and externally unusable. `code` is what
 * appears on the mizan and what an e-defter export would carry.
 *
 * Ranges, for anyone extending this:
 *   1xx dönen varlıklar · 2xx duran varlıklar · 3xx kısa vadeli yabancı kaynaklar
 *   4xx uzun vadeli yabancı kaynaklar · 5xx özkaynaklar · 6xx gelir tablosu
 *   7xx maliyet hesapları
 *
 * `name` is the statutory Turkish name — it is what appears on the mizan and in
 * an e-defter export. The English gloss beside each is for readers of this file.
 */
const STANDARD_ACCOUNTS: Record<string, { code: string; name: string; type: string; normalBalance: string }> = {
  // Physical till. A cash sale at the POS belongs here, not in the bank account —
  // every payment method used to settle to 102, so the books said money had
  // reached the bank the moment it went into the drawer.
  cash_register: { code: "100", name: "Kasa" /* Cash on hand */, type: "asset", normalBalance: "debit" },
  cash: { code: "102", name: "Bankalar" /* Banks */, type: "asset", normalBalance: "debit" },

  // ---- çek / senet -------------------------------------------------------
  // A cheque is not money until it clears, and a note is not money until it
  // matures. Both are receivables in their own right, which is why Tekdüzen
  // gives them their own accounts rather than folding them into 100/102.
  cheques_received: { code: "101", name: "Alınan Çekler" /* Cheques received */, type: "asset", normalBalance: "debit" },
  // 103 is a contra-asset in Tekdüzen ("Verilen Çekler ve Ödeme Emirleri (-)").
  // This model has no contra type, so it is carried as a liability with a credit
  // balance — the same arithmetic, and it nets correctly on the mizan.
  cheques_issued: { code: "103", name: "Verilen Çekler ve Ödeme Emirleri" /* Cheques issued */, type: "liability", normalBalance: "credit" },
  notes_receivable: { code: "121", name: "Alacak Senetleri" /* Notes receivable */, type: "asset", normalBalance: "debit" },
  notes_payable: { code: "321", name: "Borç Senetleri" /* Notes payable */, type: "liability", normalBalance: "credit" },
  accounts_receivable: { code: "120", name: "Alıcılar" /* Trade receivables */, type: "asset", normalBalance: "debit" },
  inventory: { code: "153", name: "Ticari Mallar" /* Merchandise */, type: "asset", normalBalance: "debit" },
  accounts_payable: { code: "320", name: "Satıcılar" /* Trade payables */, type: "liability", normalBalance: "credit" },
  // Goods received not invoiced. No statutory code fits exactly; 326 is the
  // "other miscellaneous payables" slot Turkish practice uses for it.
  gr_ir: { code: "326", name: "Alınan Mal Bedeli Karşılığı" /* GR/IR clearing */, type: "liability", normalBalance: "credit" },
  // 391 is OUTPUT VAT (on sales). Input VAT is 191 — see `vat_deductible`.
  tax_payable: { code: "391", name: "Hesaplanan KDV" /* Output VAT */, type: "liability", normalBalance: "credit" },
  vat_deductible: { code: "191", name: "İndirilecek KDV" /* Input VAT */, type: "asset", normalBalance: "debit" },
  retained_earnings: { code: "570", name: "Geçmiş Yıllar Kârları" /* Retained earnings */, type: "equity", normalBalance: "credit" },
  sales_revenue: { code: "600", name: "Yurtiçi Satışlar" /* Domestic sales */, type: "revenue", normalBalance: "credit" },
  cogs: { code: "621", name: "Satılan Ticari Mallar Maliyeti" /* COGS */, type: "expense", normalBalance: "debit" },
  /**
   * Kambiyo kârı / zararı — realised FX on settling a foreign-currency balance.
   *
   * An invoice for €1,000 booked at 47.0 carries 47,000 in receivables; paid at
   * 48.0 the bank receives 48,000. The 1,000 difference is neither revenue nor a
   * rounding error, and without somewhere to put it the payment entry simply
   * does not balance.
   */
  fx_gain: { code: "646", name: "Kambiyo Kârları", type: "revenue", normalBalance: "credit" },
  fx_loss: { code: "656", name: "Kambiyo Zararları", type: "expense", normalBalance: "debit" },
  purchase_price_variance: { code: "653", name: "Komisyon ve Fiyat Farkları" /* Purchase price variance */, type: "expense", normalBalance: "debit" },
  // Counter-account for stock write-offs and write-ons. Without it, adjustments
  // fell back to Inventory itself and posted a balanced entry that moved nothing.
  inventory_adjustment: { code: "654", name: "Stok Değer Düşüklüğü Karşılığı" /* Inventory adjustment */, type: "expense", normalBalance: "debit" },
  operating_expense: { code: "770", name: "Genel Yönetim Giderleri" /* Operating expenses */, type: "expense", normalBalance: "debit" },
};

/** The subtypes `requireAccount` can self-provision — checked against the
 *  `ledgerAccount.subtype` enum by tests/chart-of-accounts.test.ts. */
export const STANDARD_ACCOUNT_SUBTYPES = Object.keys(STANDARD_ACCOUNTS);

export interface JournalLineInput {
  ledgerAccountId: string;
  /** Set by the conversion step when the document was in another currency. */
  documentCurrency?: string;
  documentAmount?: number;
  exchangeRate?: number;
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
  /**
   * The DOCUMENT's currency. Required, deliberately.
   *
   * The ledger is kept in one currency, so a document in any other is converted
   * on the way in — and that conversion happens here, in the one place every
   * source posting passes through, rather than in each of the eight posting
   * functions where one could forget.
   *
   * Making it required rather than defaulting is the point: a caller that
   * omitted it would post a euro amount as lira and the entry would balance
   * perfectly while being wrong by a factor of forty. The compiler naming every
   * call site is a better guarantee than a default nobody reads. Documents
   * genuinely in the base currency pass it explicitly, which is honest.
   */
  currencyCode: string;
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
    if (debit !== credit) throw new AccountingError(`unbalanced entry: debit ${debit} ≠ credit ${credit}`).withKey("err.unbalancedEntry", { debit, credit });
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
    if (!def) throw new AccountingError(`no ledger account configured for subtype "${subtype}"`).withKey("err.noLedgerAccount", { subtype });
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
          // Denormalized from the header alongside `posted`: the aggregate engine
          // cannot join, so period reporting has to read the date off the line.
          entryDate: entry.date,
          // The document's own figures, when it was not in the ledger's currency.
          // `debit`/`credit` above are always base amounts — that is what makes a
          // trial balance addable — and these are what make the converted figure
          // explainable rather than a number nobody can trace back.
          documentCurrency: l.documentCurrency ?? null,
          documentAmount: l.documentAmount ?? null,
          exchangeRate: l.exchangeRate ?? null,
        }),
      );
    }
    return { entry, lines: created };
  }

  /** Reject posting into a closed fiscal period covering the date. */
  private async assertPeriodOpen(ctx: RequestContext, date: string): Promise<void> {
    // Every closed period must be checked: a page would let a posting slip into
    // a locked period once enough periods exist (200 = ~17 years of months).
    const periods = await this.qe.listComplete(ctx, "fiscalPeriod", {
      filters: [{ field: "status", op: "eq", value: "closed" }],
    });
    for (const p of periods) {
      if (String(p.startDate) <= date && date <= String(p.endDate)) {
        throw new AccountingError(`fiscal period "${String(p.name)}" is closed; cannot post on ${date}`).withKey("err.periodClosed", { period: String(p.name), date });
      }
    }
  }

  /** Post a draft entry: re-assert balance + open period, flip header + lines to
   *  posted — atomically, so a partially-posted (unbalanced-in-ledger) entry can
   *  never be observed if any step fails mid-way. */
  async postEntry(ctx: RequestContext, entryId: string): Promise<EntityRecord> {
    const sys = this.sys(ctx);
    const entry = await this.qe.get(sys, "journalEntry", entryId);
    if (entry.status === "posted") return entry;
    if (entry.status === "void") throw new AccountingError("cannot post a void entry");
    const lines = await this.qe.listComplete(sys, "journalLine", {
      filters: [{ field: "entryId", op: "eq", value: entryId }],
    });
    this.assertBalanced(
      lines.map((l) => ({ ledgerAccountId: String(l.ledgerAccountId), debit: Number(l.debit ?? 0), credit: Number(l.credit ?? 0) })),
    );
    await this.assertPeriodOpen(sys, String(entry.date));
    return this.qe.runInTransaction(async () => {
      for (const l of lines) await this.qe.patchComputed(sys, "journalLine", l.id, { posted: true });
      return this.qe.patchComputed(sys, "journalEntry", entryId, { status: "posted" });
    });
  }

  /**
   * Express a document's lines in the ledger's currency.
   *
   * `debit`/`credit` on a journal line are always base amounts — that is what
   * makes a trial balance addable at all. The document's own figures travel
   * alongside so the conversion stays explainable: "why is this 47,500?" answers
   * with "€1,000 at 47.5" rather than a number nobody can trace.
   */
  private async toLedgerCurrency(
    ctx: RequestContext,
    currencyCode: string,
    date: string,
    lines: JournalLineInput[],
  ): Promise<JournalLineInput[]> {
    const { isBase, rateFor } = await import("@/lib/finance/fx");
    if (isBase(currencyCode)) return lines;
    const rate = await rateFor(ctx, currencyCode, date);
    const round2 = (n: number): number => Math.round(n * 100) / 100 + 0;
    return lines.map((l) => ({
      ...l,
      debit: l.debit === undefined ? undefined : round2(Number(l.debit) * rate),
      credit: l.credit === undefined ? undefined : round2(Number(l.credit) * rate),
      documentCurrency: currencyCode.toUpperCase(),
      documentAmount: round2(Number(l.debit ?? 0) || Number(l.credit ?? 0)),
      exchangeRate: rate,
    }));
  }

  /** Create and immediately post an entry — header, lines and posting commit as one. */
  async createAndPost(ctx: RequestContext, header: JournalHeaderInput, lines: JournalLineInput[]): Promise<EntityRecord> {
    return this.qe.runInTransaction(async () => {
      const { entry } = await this.createEntry(ctx, header, lines);
      return this.postEntry(ctx, entry.id);
    });
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
    // The row itself, not the count: `total` says one exists, the item is what
    // the caller is promised.
    const found = existing.items[0];
    if (found) return found;

    // Converted ONCE, at the rate for the document's own date, and applied to
    // every line. Converting per line would look identical and stop the entry
    // balancing the moment two lines resolved different rates.
    const converted = await this.toLedgerCurrency(ctx, input.currencyCode, String(input.date), input.lines);
    return this.createAndPost(ctx, input, converted);
  }

  /** Void an entry: drafts are marked void; posted entries get a reversing entry.
   *  The reversal + the void flag commit together (a crash between them can no
   *  longer leave both the original and its reversal posted → doubled balances). */
  async voidEntry(ctx: RequestContext, entryId: string): Promise<EntityRecord> {
    const sys = this.sys(ctx);
    const entry = await this.qe.get(sys, "journalEntry", entryId);
    if (entry.status === "void") return entry;
    if (entry.status === "draft") return this.qe.patchComputed(sys, "journalEntry", entryId, { status: "void" });

    const lines = await this.qe.listComplete(sys, "journalLine", {
      filters: [{ field: "entryId", op: "eq", value: entryId }],
    });
    const reversed: JournalLineInput[] = lines.map((l) => ({
      ledgerAccountId: String(l.ledgerAccountId),
      debit: Number(l.credit ?? 0),
      credit: Number(l.debit ?? 0),
      description: `Reversal of ${String(entry.number)}`,
      branchId: (l.branchId as string) ?? null,
    }));
    return this.qe.runInTransaction(async () => {
      await this.createAndPost(sys, {
        date: sys.at.slice(0, 10),
        memo: `Reversal of ${String(entry.number)}`,
        source: "reversal",
        sourceRef: entryId,
        branchId: (entry.branchId as string) ?? null,
      }, reversed);
      return this.qe.patchComputed(sys, "journalEntry", entryId, { status: "void" });
    });
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

  /**
   * VAT position for a period — the basis of the KDV beyannamesi.
   *
   * Reads the two statutory accounts separately: 391 Hesaplanan KDV (charged on
   * sales) and 191 İndirilecek KDV (paid on purchases). Both used to land on 391,
   * which nets to the same amount owed but cannot be filed: the declaration
   * reports the two sides, not their difference.
   *
   * `to` is EXCLUSIVE — pass the first day of the next period. Dates are ISO
   * strings compared lexicographically, so an inclusive upper bound would drop
   * every entry timestamped later that same day.
   */
  async vatSummary(
    ctx: RequestContext,
    from: string,
    to: string,
    branchId?: string,
  ): Promise<VatSummary & { from: string; to: string }> {
    const sys = this.sys(ctx);
    const [outputAcc, inputAcc] = await Promise.all([
      this.accountBySubtype(sys, "tax_payable"),
      this.accountBySubtype(sys, "vat_deductible"),
    ]);

    const sideFor = async (accountId: string | undefined): Promise<{ debit: number; credit: number }> => {
      if (!accountId) return { debit: 0, credit: 0 };
      const filters: Filter[] = [
        { field: "posted", op: "eq", value: true },
        { field: "ledgerAccountId", op: "eq", value: accountId },
        ...dateRangeFilters("entryDate", from, to),
      ];
      if (branchId) filters.push({ field: "branchId", op: "eq", value: branchId });
      const rows = await this.qe.aggregate(sys, "journalLine", {
        filters,
        measures: [
          { op: "sum", field: "debit", as: "debit" },
          { op: "sum", field: "credit", as: "credit" },
        ],
      });
      return { debit: round2(rows[0]?.measures.debit ?? 0), credit: round2(rows[0]?.measures.credit ?? 0) };
    };

    const [out, inp] = await Promise.all([sideFor(outputAcc?.id), sideFor(inputAcc?.id)]);
    // 391 is a liability: charged VAT is a credit, and a debit there is a sale
    // reversed (a void or a return), so the net is what was actually charged.
    // 191 is an asset: the mirror image.
    return {
      from,
      to,
      ...summariseVat(round2(out.credit - out.debit), round2(inp.debit - inp.credit)),
    };
  }
}

const globalRef = globalThis as unknown as { __aulaAccounting?: AccountingService };

export async function getAccountingService(): Promise<AccountingService> {
  const qe = await getQueryEngine();
  globalRef.__aulaAccounting ??= new AccountingService(qe, numberSequence);
  return globalRef.__aulaAccounting;
}
