/**
 * Automation — scheduled jobs.
 *
 * A small job registry run by `POST /api/v1/cron/tick` (call from an external
 * scheduler such as a cron service, or the "Run now" button). Each run records
 * its summary so the Automation screen can show last-run status.
 */
import type { RequestContext } from "@/lib/context/types";
import { getFinanceService } from "@/lib/finance/service";
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
