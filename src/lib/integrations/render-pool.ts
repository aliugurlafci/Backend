/**
 * Render worker pool — offloads CPU-heavy document generation/parsing (exceljs,
 * pdfkit) to a small pool of worker threads so a big export/import doesn't block
 * the single event-loop thread (which would stall every other in-flight request).
 *
 * Workers are spawned lazily on first use and `unref`'d, so they never keep the
 * process alive on their own. Size the pool with `AULA_RENDER_WORKERS`
 * (default = min(2, cores-1)); set it to 0 to run everything inline on the main
 * thread — the safe fallback also used when a worker fails to start.
 *
 * The heavy code lives in the framework-free `renderers.mjs`; both the worker and
 * the inline fallback call the same routines, so output is identical either way.
 */
import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
import { logger } from "@/lib/observability/logger";
import type { ReportPayload } from "./report-export";
import type { XlsxColumnSpec } from "./renderers.mjs";

type RenderTask = "entityXlsx" | "entityPdf" | "templateXlsx" | "reportXlsx" | "parseXlsx";

const rawPoolSize = process.env.AULA_RENDER_WORKERS;
const POOL_SIZE =
  rawPoolSize === undefined || rawPoolSize === ""
    ? Math.min(2, Math.max(1, cpus().length - 1))
    : Math.max(0, Math.floor(Number(rawPoolSize)) || 0);

interface Pending {
  id: number;
  task: RenderTask;
  input: unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Handle {
  worker: Worker;
  current: Pending | null;
}

let handles: Handle[] | null = null;
const queue: Pending[] = [];
let seq = 0;

function spawn(): Handle {
  const worker = new Worker(new URL("./render.worker.mjs", import.meta.url));
  const handle: Handle = { worker, current: null };

  worker.on("message", (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
    const pending = handle.current;
    handle.current = null;
    handle.worker.unref(); // idle again — don't keep the process alive on its own
    if (pending) {
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(new Error(msg.error ?? "render worker error"));
    }
    pump();
  });

  const fail = (error: Error): void => {
    if (handle.current) {
      handle.current.reject(error);
      handle.current = null;
    }
    if (handles) {
      const i = handles.indexOf(handle);
      if (i >= 0) handles.splice(i, 1);
    }
    worker.terminate().catch(() => {});
    // A replacement is spawned lazily by the next pump().
  };

  worker.on("error", (err) => {
    logger.error("render worker error", { error: err instanceof Error ? err.message : String(err) });
    fail(err instanceof Error ? err : new Error(String(err)));
  });
  worker.on("exit", (code) => {
    if (code !== 0) fail(new Error(`render worker exited with code ${code}`));
  });

  worker.unref(); // never keep the process alive just for an idle render worker
  return handle;
}

function pump(): void {
  if (POOL_SIZE <= 0) return;
  handles ??= [];
  while (handles.length < POOL_SIZE) handles.push(spawn());
  for (const handle of handles) {
    if (handle.current) continue;
    const next = queue.shift();
    if (!next) break;
    handle.current = next;
    handle.worker.ref(); // busy — keep the process alive until this render finishes
    handle.worker.postMessage({ id: next.id, task: next.task, input: next.input });
  }
}

/** Run everything on the main thread — used when the pool is disabled (size 0). */
async function runInline(task: RenderTask, input: unknown): Promise<unknown> {
  const renderers = await import("./renderers.mjs");
  switch (task) {
    case "entityXlsx":
      return renderers.renderEntityXlsx(input as Parameters<typeof renderers.renderEntityXlsx>[0]);
    case "entityPdf":
      return renderers.renderEntityPdf(input as Parameters<typeof renderers.renderEntityPdf>[0]);
    case "templateXlsx":
      return renderers.renderTemplateXlsx(input as Parameters<typeof renderers.renderTemplateXlsx>[0]);
    case "reportXlsx":
      return renderers.renderReportXlsx(input);
    case "parseXlsx":
      return renderers.parseXlsxRows((input as { buffer: Buffer }).buffer);
  }
}

function runRender(task: RenderTask, input: unknown): Promise<unknown> {
  if (POOL_SIZE <= 0) return runInline(task, input);
  return new Promise<unknown>((resolve, reject) => {
    queue.push({ id: ++seq, task, input, resolve, reject });
    pump();
  });
}

function toBuffer(value: unknown): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
}

// ── Typed public API (identical output whether run in a worker or inline) ─────

export function renderEntityXlsx(input: {
  sheetName: string;
  columns: XlsxColumnSpec[];
  rows: Record<string, string | number>[];
}): Promise<Buffer> {
  return runRender("entityXlsx", input).then(toBuffer);
}

export function renderEntityPdf(input: {
  title: string;
  count: number;
  dateStr: string;
  /** Localized "{count} records · {date}" line; the renderer falls back to English. */
  metaLabel?: string;
  /** Localized empty-table line. */
  emptyLabel?: string;
  cols: { label: string }[];
  rows: (string | number)[][];
}): Promise<Buffer> {
  return runRender("entityPdf", input).then(toBuffer);
}

export function renderTemplateXlsx(input: { sheetName: string; headers: string[] }): Promise<Buffer> {
  return runRender("templateXlsx", input).then(toBuffer);
}

export function renderReport(payload: ReportPayload): Promise<Buffer> {
  return runRender("reportXlsx", payload).then(toBuffer);
}

export function parseXlsxRows(buffer: Buffer): Promise<string[][]> {
  return runRender("parseXlsx", { buffer }) as Promise<string[][]>;
}
