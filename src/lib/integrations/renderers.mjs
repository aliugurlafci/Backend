/**
 * Pure rendering / parsing routines (exceljs · pdfkit). Plain ESM JavaScript with
 * NO project imports — it takes already-gathered plain data and returns bytes (or
 * parses bytes into rows). This is the CPU-heavy work that would otherwise block
 * the single event-loop thread, so it runs inside `render.worker.mjs` (a worker
 * thread). `render-pool.ts` also imports it directly as an inline fallback when
 * the worker pool is disabled. Keeping it framework-free (and .mjs, not .ts) lets
 * the worker load it natively without a TypeScript loader.
 */
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

// ── entity export: xlsx ──────────────────────────────────────────────────────

/** Build a real .xlsx workbook (one sheet) from pre-mapped columns + rows. */
export async function renderEntityXlsx({ sheetName, columns, rows }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Aula CRM";
  const ws = wb.addWorksheet(sheetName);
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: "middle" };
  for (const row of rows) ws.addRow(row);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── entity export: pdf ───────────────────────────────────────────────────────

/** Build a landscape table PDF from column labels + display-string rows. */
export async function renderEntityPdf({ title, count, dateStr, cols, rows }) {
  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottom = doc.page.height - doc.page.margins.bottom;
    const colW = usableWidth / cols.length;
    const rowH = 16;
    let y = doc.page.margins.top;

    doc.fontSize(16).fillColor("#111").text(title, left, y);
    y = doc.y + 2;
    doc.fontSize(8).fillColor("#666").text(`${count} records · ${dateStr}`, left, y);
    y = doc.y + 8;

    const drawHeader = () => {
      doc.fontSize(8).fillColor("#333").font("Helvetica-Bold");
      cols.forEach((c, i) => doc.text(c.label, left + i * colW + 2, y, { width: colW - 4, ellipsis: true }));
      y += rowH;
      doc.moveTo(left, y - 4).lineTo(left + usableWidth, y - 4).strokeColor("#cccccc").lineWidth(0.5).stroke();
      doc.font("Helvetica").fillColor("#000");
    };

    drawHeader();
    for (const r of rows) {
      if (y + rowH > bottom) {
        doc.addPage();
        y = doc.page.margins.top;
        drawHeader();
      }
      doc.fontSize(8).fillColor("#111");
      cols.forEach((c, i) =>
        doc.text(String(r[i] ?? ""), left + i * colW + 2, y, {
          width: colW - 4,
          height: rowH,
          ellipsis: true,
          lineBreak: false,
        }),
      );
      y += rowH;
    }
    if (rows.length === 0) {
      doc.fontSize(9).fillColor("#888").text("No records.", left, y + 4);
    }

    doc.end();
  });
}

// ── import template: xlsx ────────────────────────────────────────────────────

/** Build an empty import template workbook (one bold header row). */
export async function renderTemplateXlsx({ sheetName, headers }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Aula CRM";
  const ws = wb.addWorksheet(sheetName);
  ws.columns = headers.map((h) => ({ header: h, key: h, width: Math.min(40, Math.max(14, h.length + 6)) }));
  ws.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── report export: styled multi-sheet xlsx ───────────────────────────────────

const HEADER_FILL = "FFF1F5F9"; // slate-100
const TITLE_COLOR = "FF0F172A"; // slate-900
const MUTED_COLOR = "FF64748B"; // slate-500

function numFmtFor(kind, currency) {
  if (kind === "currency") {
    const sym = currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "TRY" ? "₺" : "";
    return sym ? `"${sym}"#,##0.00` : "#,##0.00";
  }
  if (kind === "number") return "#,##0";
  return null;
}

function sanitizeSheetName(name, used) {
  const base = (name || "Sheet").replace(/[[\]*?/\\:]/g, " ").trim().slice(0, 28) || "Sheet";
  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base.slice(0, 25)} ${i++}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Build a styled .xlsx workbook from a pre-localized report payload. */
export async function renderReportXlsx(payload) {
  const wb = new ExcelJS.Workbook();
  wb.creator = payload.org || "Aula ERP";
  wb.created = new Date();
  const currency = payload.currency || "USD";
  const used = new Set();

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
        cell.value = v;
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
        const v = section.total[i] ?? "";
        cell.value = v;
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

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── import parse: xlsx → rows ────────────────────────────────────────────────

/** Coerce any ExcelJS cell value to text (rich text, hyperlinks, formula results,
 *  dates → ISO date). */
function cellText(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if (typeof v.text === "string") return v.text;
    if (v.result !== undefined && v.result !== null) return String(v.result);
  }
  return String(v);
}

/** Parse the first worksheet of an .xlsx workbook into rows of string cells. */
export async function parseXlsxRows(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = row.values; // 1-indexed; index 0 is empty
    const cells = [];
    for (let i = 1; i < vals.length; i++) cells.push(cellText(vals[i]));
    rows.push(cells);
  });
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}
