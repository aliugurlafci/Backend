/**
 * Background import jobs (in-memory registry).
 *
 * A large spreadsheet import (10k–100k rows) must not run inside a single HTTP
 * request/response: any proxy or database timeout along the way aborts it
 * mid-write and leaves a partial import. Instead the upload endpoint parses the
 * file, registers a job here, returns its id immediately, and the rows are
 * processed in the background (batched bulk inserts via {@link importRows})
 * while progress is recorded on the job. The client polls
 * `GET /import/:entity/job/:id` for progress and the final error report.
 *
 * Jobs live in process memory (single-instance backend): they survive the
 * request that created them but not a restart. Finished jobs are swept after a
 * grace period so the map can't grow unbounded.
 */
import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/lib/context/types";
import type { MetadataResolver } from "@/lib/metadata/resolver";
import type { DomainService } from "@/lib/domain/service";
import { logger } from "@/lib/observability/logger";
import { importRows, type ImportAliases } from "./import-export";

export type ImportJobStatus = "running" | "done" | "error";

export interface ImportJob {
  readonly id: string;
  readonly entity: string;
  status: ImportJobStatus;
  /** Data rows to process (excludes the header row). */
  readonly total: number;
  processed: number;
  created: number;
  failed: number;
  /** A capped sample of per-row errors (full count is `failed`). */
  errors: { row: number; message: string }[];
  ignored: string[];
  /** Set when `status === "error"` (the import itself threw). */
  message?: string;
  readonly startedAt: number;
  finishedAt?: number;
  // Owning scope — used to isolate reads to the creating tenant/org.
  readonly tenantId: string;
  readonly orgId: string;
}

/** Public projection of a job (no internal scope fields). */
export interface ImportJobView {
  jobId: string;
  status: ImportJobStatus;
  total: number;
  processed: number;
  created: number;
  failed: number;
  errors: { row: number; message: string }[];
  ignored: string[];
  message?: string;
}

const MAX_ERRORS = 500; // cap stored errors so a fully-failing import can't pin 100k strings
const SWEEP_AFTER_MS = 10 * 60_000; // keep finished jobs readable for 10 minutes

const jobs = new Map<string, ImportJob>();

/** Drop finished jobs older than the grace period (lazy, on each new job). */
function sweep(now: number): void {
  for (const [id, job] of jobs) {
    if (job.finishedAt !== undefined && now - job.finishedAt > SWEEP_AFTER_MS) jobs.delete(id);
  }
}

export function toView(job: ImportJob): ImportJobView {
  return {
    jobId: job.id,
    status: job.status,
    total: job.total,
    processed: job.processed,
    created: job.created,
    failed: job.failed,
    errors: job.errors,
    ignored: job.ignored,
    message: job.message,
  };
}

/** Fetch a job, but only if it belongs to the caller's tenant/org. */
export function getImportJob(ctx: RequestContext, id: string): ImportJob | null {
  const job = jobs.get(id);
  if (!job || job.tenantId !== ctx.tenantId || job.orgId !== ctx.orgId) return null;
  return job;
}

/**
 * Register and start a background import. Returns the job immediately (status
 * `running`); the rows are processed on a floating promise that updates the job
 * as it goes. Parse the file *before* calling this so a corrupt upload fails
 * fast as a 400 on the request itself.
 */
export function startImportJob(
  ctx: RequestContext,
  entity: string,
  rows: string[][],
  metadata: MetadataResolver,
  domain: DomainService,
  aliases?: ImportAliases,
): ImportJob {
  sweep(Date.now());

  const job: ImportJob = {
    id: randomUUID(),
    entity,
    status: "running",
    total: Math.max(0, rows.length - 1), // minus the header row
    processed: 0,
    created: 0,
    failed: 0,
    errors: [],
    ignored: [],
    startedAt: Date.now(),
    tenantId: ctx.tenantId,
    orgId: ctx.orgId,
  };
  jobs.set(job.id, job);

  // Fire-and-forget: the response has already returned the job id; this runs in
  // the background and records its outcome on the job. Any throw is captured so
  // it can never become an unhandledRejection.
  void (async () => {
    try {
      const result = await importRows(ctx, entity, rows, metadata, domain, aliases, (p) => {
        job.processed = p.processed;
        job.created = p.created;
        job.failed = p.failed;
      });
      job.created = result.created.length;
      job.failed = result.errors.length;
      job.errors = result.errors.slice(0, MAX_ERRORS);
      job.ignored = result.ignored ?? [];
      job.processed = job.total;
      job.status = "done";
    } catch (e) {
      job.status = "error";
      job.message = e instanceof Error ? e.message : String(e);
      logger.error("import job failed", { id: job.id, entity, error: job.message });
    } finally {
      job.finishedAt = Date.now();
    }
  })();

  return job;
}
