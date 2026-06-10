/**
 * Report export — renders a professional, multi-sheet Excel workbook from a
 * pre-localized report payload posted by the client. The client already holds the
 * i18n catalog, so it sends display strings (titles, headers, KPIs) plus raw
 * numbers for numeric cells; this module only lays them out and formats numbers.
 *
 * PDF export is handled on the client via the browser's print-to-PDF (full
 * Unicode + theme), matching how the app prints invoices/labels/receipts.
 */
import ExcelJS from "exceljs";

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

const HEADER_FILL = "FFF1F5F9"; // slate-100
const TITLE_COLOR = "FF0F172A"; // slate-900
const MUTED_COLOR = "FF64748B"; // slate-500

function numFmtFor(kind: ReportCellKind | undefined, currency: string): string | null {
  if (kind === "currency") {
    const sym = currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "TRY" ? "₺" : "";
    return sym ? `"${sym}"#,##0.00` : "#,##0.00";
  }
  if (kind === "number") return "#,##0";
  return null;
}

function sanitizeSheetName(name: string, used: Set<string>): string {
  let base = (name || "Sheet").replace(/[[\]*?/\\:]/g, " ").trim().slice(0, 28) || "Sheet";
  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base.slice(0, 25)} ${i++}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Build a styled .xlsx workbook from a report payload. */
export async function renderReportXlsx(payload: ReportPayload): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = payload.org || "Aula ERP";
  wb.created = new Date();
  const currency = payload.currency || "USD";
  const used = new Set<string>();

  // ── Summary sheet (title, metadata, KPIs) ──────────────────────────────
  const summary = wb.addWorksheet(sanitizeSheetName(payload.title, used), {
    views: [{ showGridLines: false }],
  });
  summary.columns = [{ width: 30 }, { width: 30 }, { width: 18 }, { width: 18 }];

  summary.mergeCells("A1:D1");
  const titleCell = summary.getCell("A1");
  titleCell.value = payload.title;
  titleCell.font = { size: 18, bold: true, color: { argb: TITLE_COLOR } };
  let row = 2;
  if (payload.subtitle) {
    summary.mergeCells(`A2:D2`);
    const sc = summary.getCell("A2");
    sc.value = payload.subtitle;
    sc.font = { size: 11, color: { argb: MUTED_COLOR } };
    row = 3;
  }
  row += 1;
  for (const m of payload.meta ?? []) {
    summary.getCell(`A${row}`).value = m.label;
    summary.getCell(`A${row}`).font = { color: { argb: MUTED_COLOR } };
    summary.getCell(`B${row}`).value = m.value;
    row++;
  }

  if (payload.kpis?.length) {
    row += 1;
    summary.getCell(`A${row}`).value = "KPI";
    summary.getCell(`A${row}`).font = { bold: true };
    row++;
    for (const k of payload.kpis) {
      summary.getCell(`A${row}`).value = k.label;
      summary.getCell(`A${row}`).font = { color: { argb: MUTED_COLOR } };
      const vc = summary.getCell(`B${row}`);
      vc.value = k.value;
      vc.font = { bold: true };
      row++;
    }
  }

  // ── One sheet per section ──────────────────────────────────────────────
  for (const section of payload.sections) {
    const ws = wb.addWorksheet(sanitizeSheetName(section.title, used));
    const cols = section.columns;
    ws.columns = cols.map((c) => ({
      width: Math.min(44, Math.max(14, c.label.length + 4)),
    }));

    // Section title row
    ws.mergeCells(1, 1, 1, Math.max(1, cols.length));
    const st = ws.getCell(1, 1);
    st.value = section.title;
    st.font = { size: 13, bold: true, color: { argb: TITLE_COLOR } };

    // Header row
    const headerRowIdx = 3;
    const header = ws.getRow(headerRowIdx);
    cols.forEach((c, i) => {
      const cell = header.getCell(i + 1);
      cell.value = c.label;
      cell.font = { bold: true, color: { argb: TITLE_COLOR } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
      cell.alignment = { horizontal: c.align ?? (c.kind && c.kind !== "text" ? "right" : "left") };
      cell.border = { bottom: { style: "thin", color: { argb: "FFCBD5E1" } } };
    });

    // Data rows
    let r = headerRowIdx + 1;
    for (const dataRow of section.rows) {
      const wr = ws.getRow(r);
      cols.forEach((c, i) => {
        const cell = wr.getCell(i + 1);
        const v = dataRow[i] ?? "";
        cell.value = v as ExcelJS.CellValue;
        const fmt = numFmtFor(c.kind, currency);
        if (fmt && typeof v === "number") cell.numFmt = fmt;
        cell.alignment = { horizontal: c.align ?? (c.kind && c.kind !== "text" ? "right" : "left") };
      });
      r++;
    }

    // Totals row
    if (section.total) {
      const tr = ws.getRow(r);
      cols.forEach((c, i) => {
        const cell = tr.getCell(i + 1);
        const v = section.total![i] ?? "";
        cell.value = v as ExcelJS.CellValue;
        cell.font = { bold: true };
        const fmt = numFmtFor(c.kind, currency);
        if (fmt && typeof v === "number") cell.numFmt = fmt;
        cell.alignment = { horizontal: c.align ?? (c.kind && c.kind !== "text" ? "right" : "left") };
        cell.border = { top: { style: "thin", color: { argb: "FFCBD5E1" } } };
      });
      r++;
    }

    if (cols.length > 0) {
      ws.autoFilter = { from: { row: headerRowIdx, column: 1 }, to: { row: headerRowIdx, column: cols.length } };
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}
