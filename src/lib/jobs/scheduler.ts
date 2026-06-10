/**
 * Automation — scheduled jobs.
 *
 * A small job registry run by `POST /api/v1/cron/tick` (call from an external
 * scheduler such as a cron service, or the "Run now" button). Each run records
 * its summary so the Automation screen can show last-run status.
 */
import type { RequestContext } from "@/lib/context/types";
import { systemContext } from "@/lib/context/resolver";
import { DEMO_ORG, DEMO_TENANT } from "@/lib/context/dev";
import { getFinanceService } from "@/lib/finance/service";
import { runScheduledAutomations, processQueue } from "@/lib/automation/engine";
import { logger } from "@/lib/observability/logger";

export interface JobResult {
  name: string;
  at: string;
  summary: string;
}

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
];

class JobRunLog {
  private last = new Map<string, JobResult>();
  record(r: JobResult): void {
    this.last.set(r.name, r);
  }
  get(name: string): JobResult | undefined {
    return this.last.get(name);
  }
}

const jobLog = new JobRunLog();

export async function runAllJobs(ctx: RequestContext): Promise<JobResult[]> {
  const results: JobResult[] = [];
  for (const job of JOBS) {
    try {
      const summary = await job.run(ctx);
      const result = { name: job.name, at: ctx.at, summary };
      jobLog.record(result);
      results.push(result);
    } catch (e) {
      const summary = `failed: ${e instanceof Error ? e.message : String(e)}`;
      jobLog.record({ name: job.name, at: ctx.at, summary });
      results.push({ name: job.name, at: ctx.at, summary });
      logger.error("scheduled job failed", { job: job.name, error: summary });
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
      const ctx = systemContext(DEMO_TENANT, DEMO_ORG);
      await runAllJobs(ctx);
      await runScheduledAutomations(ctx); // cadence-aware (no force)
      await processQueue(ctx); // drain pending + due-retry items to completion
    } catch (e) {
      logger.error("scheduler tick failed", { error: e instanceof Error ? e.message : String(e) });
    }
  };

  schedulerTimer = setInterval(() => void tick(), seconds * 1000);
  schedulerTimer.unref?.();
  logger.info("in-process scheduler started", { everySeconds: seconds });
}
