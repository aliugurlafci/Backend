/**
 * Render worker — runs the CPU-heavy exceljs / pdfkit work off the main event
 * loop. Receives `{ id, task, input }` from `render-pool.ts`, dispatches to the
 * matching pure routine in `renderers.mjs`, and posts back `{ id, ok, result }`
 * (result = a Buffer or parsed rows) or `{ id, ok: false, error }`.
 */
import { parentPort } from "node:worker_threads";
import {
  renderEntityXlsx,
  renderEntityPdf,
  renderTemplateXlsx,
  renderReportXlsx,
  parseXlsxRows,
} from "./renderers.mjs";

const handlers = {
  entityXlsx: (input) => renderEntityXlsx(input),
  entityPdf: (input) => renderEntityPdf(input),
  templateXlsx: (input) => renderTemplateXlsx(input),
  reportXlsx: (input) => renderReportXlsx(input),
  parseXlsx: (input) => parseXlsxRows(input.buffer),
};

parentPort.on("message", async ({ id, task, input }) => {
  try {
    const handler = handlers[task];
    if (!handler) throw new Error(`unknown render task: ${task}`);
    const result = await handler(input);
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
