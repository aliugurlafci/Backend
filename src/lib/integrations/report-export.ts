/**
 * Report export — renders a professional, multi-sheet Excel workbook from a
 * pre-localized report payload posted by the client. The client already holds the
 * i18n catalog, so it sends display strings (titles, headers, KPIs) plus raw
 * numbers for numeric cells; the renderer only lays them out and formats numbers.
 *
 * The actual exceljs layout runs off the event loop in the render worker pool
 * (see `render-pool.ts` / `renderers.mjs`); this module owns the payload types.
 *
 * PDF export is handled on the client via the browser's print-to-PDF (full
 * Unicode + theme), matching how the app prints invoices/labels/receipts.
 */
import { renderReport } from "./render-pool";

export type ReportCellKind = "text" | "number" | "currency";

export interface ReportColumn {
  label: string;
  kind?: ReportCellKind;
  align?: "left" | "right" | "center";
}

export interface ReportSection {
  title: string;
  columns: ReportColumn[];
  rows: (string | number | null)[][];
  /** Optional totals row, aligned 1:1 with `columns`. */
  total?: (string | number | null)[];
  note?: string;
}

export interface ReportPayload {
  title: string;
  subtitle?: string;
  org?: string;
  meta?: { label: string; value: string }[];
  kpis?: { label: string; value: string }[];
  sections: ReportSection[];
  currency?: string;
}

/** Build a styled .xlsx workbook from a report payload (rendered off-thread). */
export async function renderReportXlsx(payload: ReportPayload): Promise<Buffer> {
  return renderReport(payload);
}
