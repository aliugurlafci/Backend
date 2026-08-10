/**
 * Automation — scheduled jobs.
 *
 * A small job registry run by `POST /api/v1/cron/tick` (call from an external
 * scheduler such as a cron service, or the "Run now" button). Each run records
 * its summary so the Automation screen can show last-run status.
 */
import type { RequestContext } from "@/lib/context/types";
import { systemContext } from "@/lib/context/resolver";
import { ORG_ID, TENANT_ID } from "@/lib/config/env";
import { getFinanceService } from "@/lib/finance/service";
import { runScheduledAutomations, processQueue } from "@/lib/automation/engine";
import { retryFailedPostings } from "@/lib/accounting/postings";
import { logger } from "@/lib/observability/logger";
import { acquireLease, instanceId } from "./lease";

export interface JobResult {
  name: string;
  at: string;
  summary: string;
  ok: boolean;
  /** Consecutive failures so far; jobs are idempotent and re-run every tick. */
  failStreak?: number;
}

/**
 * How long each operational log is kept.
 *
 * These are not compliance records — they exist to answer "did that go out?" and
 * "why did that fail?", both of which are asked within days. The audit trail is
 * deliberately absent from this list: it is kept indefinitely.
 */
const RETENTION_DAYS = {
  webhookDeliveries: 30,
  publishedEvents: 7,
  notifications: 60,
} as const;

/** A job that has failed this many ticks in a row is escalated (dead-letter alert). */
const JOB_DLQ_THRESHOLD = 3;

export interface JobDef {
  name: string;
  label: string;
  schedule: string;
  run: (ctx: RequestContext) => Promise<string>;
}

export const JOBS: JobDef[] = [
  {
    name: "billing-run",
    label: "Recurring billing",
    schedule: "daily",
    run: async (ctx) => {
      const fin = await getFinanceService();
      const ids = await fin.generateDueInvoices(ctx);
      return `${ids.length} invoice(s) generated`;
    },
  },
  {
    name: "mark-overdue",
    label: "Mark overdue invoices",
    schedule: "daily",
    run: async (ctx) => {
      const fin = await getFinanceService();
      const n = await fin.markOverdue(ctx);
      return `${n} invoice(s) marked overdue`;
    },
  },
  {
    name: "outbox-recovery",
    label: "Deliver stranded outbox events",
    // Frequently: an event stuck here is an automation that has not fired or a
    // webhook that has not been sent, and every minute of delay is visible to
    // whoever was waiting for it.
    schedule: "always",
    run: async (ctx) => {
      const { Outbox } = await import("@/lib/workflow/outbox");
      const { eventBus } = await import("@/lib/workflow/event-bus");
      const { IdempotencyStore } = await import("@/lib/workflow/idempotency");
      const outbox = new Outbox(eventBus, new IdempotencyStore());
      const { delivered, failed } = await outbox.recoverPending(ctx);
      if (delivered === 0 && failed === 0) return "no stranded events";
      return `${delivered} delivered, ${failed} still pending`;
    },
  },
  {
    name: "retention",
    label: "Prune expired log rows",
    schedule: "daily",
    run: async (ctx) => {
      // Three tables grow with traffic and are only ever read recently: webhook
      // delivery attempts, published outbox rows, and the audit trail. The first
      // two are operational logs with no compliance value once acted upon; the
      // audit trail is kept far longer because "who voided this invoice" is a
      // question asked months later.
      const { webhookRegistry } = await import("@/lib/integrations/webhooks");
      const deliveries = await webhookRegistry.pruneDeliveries(ctx.tenantId, ctx.orgId, RETENTION_DAYS.webhookDeliveries);
      const { prunePublished } = await import("@/lib/workflow/outbox-retention");
      const outbox = await prunePublished(ctx, RETENTION_DAYS.publishedEvents);
      const { notifications } = await import("@/lib/integrations/notifications");
      const bells = await notifications.prune(ctx.tenantId, ctx.orgId, RETENTION_DAYS.notifications);
      // Revoked tokens are kept only until they would have expired on their own;
      // after that the token's `exp` refuses it and the row is pure cost.
      const { pruneRevocations } = await import("@/lib/security/revocation");
      const tokens = await pruneRevocations(ctx);
      return `pruned ${deliveries} delivery log row(s), ${outbox} published event(s), ${bells} notification(s), ${tokens} expired revocation(s)`;
    },
  },
  {
    name: "stock-reconcile",
    label: "Reconcile stock balances",
    schedule: "daily",
    run: async (ctx) => {
      // Report-only on purpose. Balances and the ledger are written in one
      // transaction and the movement records the exact value applied, so they
      // cannot legitimately disagree — drift means a bug, and quietly repairing
      // it on a schedule would hide the bug rather than surface it. Repair is a
      // deliberate operator action via POST /inventory/reconcile.
      const { reconcileStockBalances } = await import("@/lib/inventory/reconcile");
      const result = await reconcileStockBalances(ctx, { apply: false });
      return result.drifted.length === 0
        ? `${result.checked} balance(s) match the ledger`
        : `DRIFT: ${result.drifted.length} of ${result.checked} balance(s) disagree with the ledger`;
    },
  },
  {
    name: "stock-alerts",
    label: "Detect stock conditions",
    schedule: "daily",
    run: async (ctx) => {
      // Opening an alert emits `stockAlert.created`, which is what the
      // automation rules react to. Nothing here sends a message itself — who
      // gets told, through which channel, and under what conditions belongs in
      // a rule the buyer can change without a deploy.
      const { scanStockAlerts } = await import("@/lib/inventory/alerts");
      const r = await scanStockAlerts(ctx);
      return `${r.scanned} balance(s): ${r.opened} new alert(s), ${r.ongoing} ongoing, ${r.resolved} resolved`;
    },
  },
  {
    name: "lot-expiry",
    label: "Expire lots past their date",
    schedule: "daily",
    run: async (ctx) => {
      // Status only. The stock stays on the shelf and stays valued, because it
      // is physically there — writing it off is a decision with a journal entry
      // behind it. What changes is that it can no longer be picked, which is
      // the part a person should not be relied on to notice.
      const { expireLots } = await import("@/lib/inventory/lots");
      const expired = await expireLots(ctx);
      return expired === 0 ? "no lots expired" : `${expired} lot(s) marked expired`;
    },
  },
  {
    name: "erp-dispatch",
    label: "Send queued messages to SAP",
    // Every tick. Cheap when the queue is empty — one indexed read — and the
    // sooner a staged invoice reaches SAP the smaller the window in which the
    // two systems disagree.
    schedule: "minutely",
    run: async (ctx) => {
      // Staged, then sent here. The two cannot be one operation: PI/PO is
      // reached over a network, so "post the invoice and tell SAP" would mean
      // holding a database transaction open across an HTTP call.
      const { dispatchOutbound } = await import("@/lib/erp/sync");
      const r = await dispatchOutbound(ctx);
      return `${r.sent} sent, ${r.failed} retrying, ${r.dead} dead-lettered`;
    },
  },
  {
    name: "operations-alerts",
    label: "Detect purchasing, count and till conditions",
    schedule: "daily",
    run: async (ctx) => {
      // Same arrangement as `stock-alerts`: this only decides WHAT is wrong.
      // Who gets told, through which channel, and under what conditions is an
      // automation rule that the buyer or the accountant can change without a
      // deploy.
      const { scanOperationsAlerts } = await import("@/lib/ops/alerts");
      const r = await scanOperationsAlerts(ctx);
      return `${r.scanned} document(s): ${r.opened} new alert(s), ${r.ongoing} ongoing, ${r.resolved} resolved`;
    },
  },
  {
    name: "calendar-due-dates",
    label: "Project document due dates onto the calendar",
    schedule: "daily",
    run: async (ctx) => {
      // A full sweep rather than an incremental update: the open-document set is
      // small, and a sweep converges after a missed run instead of compounding.
      const { syncDueDates } = await import("@/lib/calendar/due-dates");
      const r = await syncDueDates(ctx);
      return `${r.created} added, ${r.updated} updated, ${r.removed} settled`;
    },
  },
];

class JobRunLog {
  private last = new Map<string, JobResult>();
  /** Consecutive-failure counter per job (resets on success). */
  private streak = new Map<string, number>();
  record(r: JobResult): void {
    this.last.set(r.name, r);
  }
  get(name: string): JobResult | undefined {
    return this.last.get(name);
  }
  bumpStreak(name: string, failed: boolean): number {
    const next = failed ? (this.streak.get(name) ?? 0) + 1 : 0;
    this.streak.set(name, next);
    return next;
  }
}

const jobLog = new JobRunLog();

export async function runAllJobs(ctx: RequestContext): Promise<JobResult[]> {
  const results: JobResult[] = [];
  for (const job of JOBS) {
    try {
      const summary = await job.run(ctx);
      jobLog.bumpStreak(job.name, false);
      const result: JobResult = { name: job.name, at: ctx.at, summary, ok: true, failStreak: 0 };
      jobLog.record(result);
      results.push(result);
    } catch (e) {
      // Jobs are idempotent and re-run every tick, so this IS the retry; we track
      // the consecutive-failure streak and escalate (dead-letter) on persistence.
      const failStreak = jobLog.bumpStreak(job.name, true);
      const summary = `failed: ${e instanceof Error ? e.message : String(e)}`;
      const result: JobResult = { name: job.name, at: ctx.at, summary, ok: false, failStreak };
      jobLog.record(result);
      results.push(result);
      if (failStreak >= JOB_DLQ_THRESHOLD) {
        logger.error("scheduled job repeatedly failing (dead-letter — needs attention)", { job: job.name, failStreak, error: summary });
      } else {
        logger.error("scheduled job failed (will retry next tick)", { job: job.name, failStreak, error: summary });
      }
    }
  }
  return results;
}

export function jobsStatus(): { name: string; label: string; schedule: string; last?: JobResult }[] {
  return JOBS.map((j) => ({ name: j.name, label: j.label, schedule: j.schedule, last: jobLog.get(j.name) }));
}

// ---- in-process scheduler ---------------------------------------------------

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start an in-process scheduler so the recurring jobs **and** active
 * schedule-triggered automations run automatically for the demo tenant, with no
 * external cron. The billing/overdue jobs are idempotent and each automation
 * respects its own cadence (hourly/daily/weekly), so frequent ticks are safe.
 *
 * Opt out with `AULA_SCHEDULER=off`; tune the period with `AULA_SCHEDULER_SECONDS`
 * (default 60, min 15). Idempotent; the timer is `unref`'d so it never blocks
 * shutdown. For multi-tenant deployments, keep driving `POST /cron/tick` per
 * tenant from an external scheduler — this in-process loop covers the demo tenant.
 */
export function startScheduler(): void {
  if (schedulerTimer) return;
  if (String(process.env.AULA_SCHEDULER ?? "").toLowerCase() === "off") {
    logger.info("in-process scheduler disabled (AULA_SCHEDULER=off)");
    return;
  }
  const seconds = Math.max(15, Number(process.env.AULA_SCHEDULER_SECONDS ?? 60) || 60);

  const tick = async (): Promise<void> => {
    try {
      const ctx = systemContext(TENANT_ID, ORG_ID);

      // One instance runs the jobs; the others wait. Not merely wasteful
      // otherwise — the jobs are idempotent only where each was written to be,
      // and `stock-alerts` is the counter-example: two concurrent scans both see
      // no open alert and both create one, so the buyer is told twice and learns
      // to ignore the channel. The lease is renewed here, so a healthy leader
      // refreshes it several times within one lease period.
      if (!(await acquireLease(ctx.at))) return;

      await runAllJobs(ctx);
      await retryFailedPostings(); // re-attempt any GL/stock postings that failed
      await runScheduledAutomations(ctx); // cadence-aware (no force)
      await processQueue(ctx); // drain pending + due-retry items to completion
    } catch (e) {
      logger.error("scheduler tick failed", { error: e instanceof Error ? e.message : String(e) });
    }
  };

  schedulerTimer = setInterval(() => void tick(), seconds * 1000);
  schedulerTimer.unref?.();
  logger.info("in-process scheduler started", { everySeconds: seconds, leaseHolder: instanceId() });
}
