/**
 * The ledger: journal entries, the trial balance, e-Fatura/e-Arşiv, the VAT
 * position, and the recurring billing run that feeds them.
 */

import { type Router } from "express";
import { runApi, setApiHeaders, pathParam } from "@/lib/http/handler";
import { getDomainService } from "@/lib/domain";
import { getFinanceService } from "@/lib/finance/service";
import { getAccountingService } from "@/lib/accounting/service";
import { permissionEngine } from "@/lib/permissions/engine";
import { runAllJobs, jobsStatus } from "@/lib/jobs/scheduler";
import { retryFailedPostings } from "@/lib/accounting/postings";
import { runScheduledAutomations } from "@/lib/automation";
import { createJournalEntrySchema, eInvoiceSchema, parseBody } from "@/lib/http/body";
import { ForbiddenError } from "@/lib/enforcement/errors";
import { systemContext } from "@/lib/context/resolver";

export function registerAccountingRoutes(r: Router): void {
  // ---- accounting: journal entries -------------------------------------
  r.post(
    "/journal-entries",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, createJournalEntrySchema);
        const acc = await getAccountingService();
        const { entry } = await acc.createEntry(rc, { date: body.date, memo: body.memo ?? null, source: "manual", branchId: body.branchId ?? null }, body.lines ?? []);
        if (body.post) {
          if (!permissionEngine.can(rc, { entity: "journalEntry", action: "journalEntry:post" })) {
            throw new ForbiddenError("not allowed to post journal entries");
          }
          const posted = await acc.postEntry(rc, entry.id);
          return { entry: posted };
        }
        return { entry };
      },
      { mutating: true, status: 201 },
    ),
  );

  r.post(
    "/journal-entries/:id/post",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "journalEntry", action: "journalEntry:post" })) {
          throw new ForbiddenError("not allowed to post journal entries");
        }
        const acc = await getAccountingService();
        return { entry: await acc.postEntry(rc, pathParam(req, "id")) };
      },
      { mutating: true },
    ),
  );

  r.post(
    "/journal-entries/:id/void",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "journalEntry", action: "journalEntry:post" })) {
          throw new ForbiddenError("not allowed to void journal entries");
        }
        const acc = await getAccountingService();
        return { entry: await acc.voidEntry(rc, pathParam(req, "id")) };
      },
      { mutating: true },
    ),
  );

  r.get("/accounting/trial-balance", runApi(async (rc, req) => {
    const acc = await getAccountingService();
    const branchId = typeof req.query.branchId === "string" ? req.query.branchId : undefined;
    return { rows: await acc.trialBalance(rc, branchId) };
  }));

  // ---- e-Fatura / e-Arşiv ----------------------------------------------
  // Building and sending are separate on purpose: the document can be prepared,
  // inspected and corrected with no integrator configured at all. Only
  // transmission needs a provider.
  r.post(
    "/invoices/:id/e-invoice",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, eInvoiceSchema);
        const { prepareEInvoice } = await import("@/lib/einvoice/service");
        return prepareEInvoice(rc, pathParam(req, "id"), { series: body.series });
      },
      { mutating: true, status: 201 },
    ),
  );

  r.post(
    "/e-invoices/:id/send",
    runApi(
      async (rc, req) => {
        const { sendEInvoice } = await import("@/lib/einvoice/service");
        return sendEInvoice(rc, pathParam(req, "id"));
      },
      { mutating: true },
    ),
  );

  // The UBL document exactly as stored — what was (or will be) submitted.
  r.get("/e-invoices/:id/xml", runApi(async (rc, req, res) => {
    const domain = await getDomainService();
    const doc = await domain.get(rc, "eInvoice", pathParam(req, "id"));
    setApiHeaders(res);
    res.type("application/xml").send(String(doc.xml ?? ""));
  }));

  // VAT position for a period — the basis of the KDV beyannamesi.
  // `?from=YYYY-MM-DD&to=YYYY-MM-DD`, where `to` is EXCLUSIVE (pass the first day
  // of the next period). Defaults to the current calendar month.
  r.get("/accounting/vat-summary", runApi(async (rc, req) => {
    const acc = await getAccountingService();
    const monthStart = `${rc.at.slice(0, 7)}-01`;
    const nextMonth = (() => {
      // `monthStart` is built above as YYYY-MM-DD, so both parts are present;
      // the defaults keep a malformed value from producing "NaN" inside a date
      // string that would then be compared lexicographically against real ones.
      const [y = 0, m = 1] = monthStart.split("-").map(Number);
      return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    })();
    const from = typeof req.query.from === "string" && req.query.from ? req.query.from : monthStart;
    const to = typeof req.query.to === "string" && req.query.to ? req.query.to : nextMonth;
    const branchId = typeof req.query.branchId === "string" ? req.query.branchId : undefined;
    return acc.vatSummary(rc, from, to, branchId);
  }));


  // ---- recurring billing + cron ----------------------------------------
  r.post(
    "/recurring/run",
    runApi(
      async (rc) => {
        const fin = await getFinanceService();
        const generated = await fin.generateDueInvoices(rc);
        return { generated, count: generated.length };
      },
      { mutating: true },
    ),
  );

  r.post(
    "/cron/tick",
    runApi(
      async (rc) => {
        if (!rc.roles.includes("admin")) throw new ForbiddenError("admins only");
        const results = await runAllJobs(rc);
        // Re-attempt any GL/stock postings that previously failed (idempotent).
        const postings = await retryFailedPostings();
        if (postings.retried > 0) {
          results.push({ name: "posting-retry", at: rc.at, ok: postings.dead === 0, summary: `${postings.recovered} recovered, ${postings.remaining} pending, ${postings.dead} dead` });
        }
        // Also fire any active schedule-triggered automations (force: a manual /
        // external tick runs them all now, regardless of per-rule cadence).
        const automations = await runScheduledAutomations(systemContext(rc.tenantId, rc.orgId), { force: true });
        if (automations.length) {
          const ok = automations.filter((a) => a.status === "success").length;
          results.push({ name: "automations", at: rc.at, ok: true, summary: `${ok}/${automations.length} scheduled automation(s) ran` });
        }
        return { results };
      },
      { mutating: true },
    ),
  );

  // Scheduled-job registry + last-run status (for the Automation screen).
  r.get("/jobs", runApi(async () => ({ jobs: jobsStatus() })));

}
