/** Type declarations for the framework-free renderers in `renderers.mjs`. */

export interface XlsxColumnSpec {
  header: string;
  key: string;
  width: number;
}

export function renderEntityXlsx(input: {
  sheetName: string;
  columns: XlsxColumnSpec[];
  rows: Record<string, string | number>[];
}): Promise<Buffer>;

export function renderEntityPdf(input: {
  title: string;
  count: number;
  dateStr: string;
  cols: { label: string }[];
  rows: (string | number)[][];
}): Promise<Buffer>;

export function renderTemplateXlsx(input: { sheetName: string; headers: string[] }): Promise<Buffer>;

/** `payload` is the `ReportPayload` shape; typed loosely here to keep this .mjs
 *  boundary decoupled — the typed wrapper lives in `render-pool.ts`. */
export function renderReportXlsx(payload: unknown): Promise<Buffer>;

export function parseXlsxRows(buffer: Buffer): Promise<string[][]>;
