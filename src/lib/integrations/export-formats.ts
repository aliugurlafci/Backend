/**
 * Excel (.xlsx) and PDF export of entity records.
 *
 * Reads enforced records through the domain service (so permissions + field
 * projection apply), then renders a real workbook (exceljs) or a paginated table
 * PDF (pdfkit). CSV stays in `import-export.ts` for round-trip import.
 *
 * Note: the PDF uses pdfkit's built-in Helvetica (WinAnsi). Latin text renders
 * fine; for full Turkish glyph coverage embed a Unicode TTF via `doc.font(path)`.
 */
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import type { RequestContext } from "@/lib/context/types";
import type { MetadataResolver } from "@/lib/metadata/resolver";
import type { DomainService } from "@/lib/domain/service";
import type { EntityDef, EntityRecord, FieldDef, FieldValue } from "@/lib/metadata/types";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Human-friendly cell value (enum → option label, boolean → Yes/No). */
function display(field: FieldDef | undefined, value: FieldValue): string | number {
  if (value === null || value === undefined || value === "") return "";
  if (field?.type === "enum") return field.options?.find((o) => o.value === value)?.label ?? String(value);
  if (field?.type === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return round2(value);
  return String(value);
}

async function collect(
  ctx: RequestContext,
  entityName: string,
  metadata: MetadataResolver,
  domain: DomainService,
): Promise<{ entity: EntityDef; items: EntityRecord[] }> {
  const entity = metadata.getEntity(entityName);
  const page = await domain.list(ctx, entityName, { pageSize: 1000 });
  return { entity, items: page.items };
}

/** Build a real .xlsx workbook (one sheet) for an entity. */
export async function exportXlsx(
  ctx: RequestContext,
  entityName: string,
  metadata: MetadataResolver,
  domain: DomainService,
): Promise<Buffer> {
  const { entity, items } = await collect(ctx, entityName, metadata, domain);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Aula CRM";
  const ws = wb.addWorksheet(entity.pluralLabel.slice(0, 31));

  ws.columns = [
    { header: "ID", key: "id", width: 26 },
    ...entity.fields.map((f) => ({ header: f.label, key: f.name, width: Math.min(40, Math.max(14, f.label.length + 6)) })),
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: "middle" };

  for (const r of items) {
    const row: Record<string, unknown> = { id: r.id };
    for (const f of entity.fields) row[f.name] = display(f, r[f.name] ?? null);
    ws.addRow(row);
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

/** Build a landscape table PDF for an entity (uses listColumns to fit the page). */
export async function exportPdf(
  ctx: RequestContext,
  entityName: string,
  metadata: MetadataResolver,
  domain: DomainService,
): Promise<Buffer> {
  const { entity, items } = await collect(ctx, entityName, metadata, domain);

  // Keep the table readable: prefer the configured list columns, capped at 7.
  const fieldByName = new Map(entity.fields.map((f) => [f.name, f]));
  const listed = (entity.listColumns ?? [])
    .map((c) => fieldByName.get(c.field))
    .filter((f): f is FieldDef => Boolean(f));
  const cols: FieldDef[] = (listed.length ? listed : entity.fields).slice(0, 7);

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36 });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottom = doc.page.height - doc.page.margins.bottom;
    const colW = usableWidth / cols.length;
    const rowH = 16;
    let y = doc.page.margins.top;

    doc.fontSize(16).fillColor("#111").text(entity.pluralLabel, left, y);
    y = doc.y + 2;
    doc.fontSize(8).fillColor("#666").text(`${items.length} records · ${new Date().toISOString().slice(0, 10)}`, left, y);
    y = doc.y + 8;

    const drawHeader = () => {
      doc.fontSize(8).fillColor("#333").font("Helvetica-Bold");
      cols.forEach((c, i) => doc.text(c.label, left + i * colW + 2, y, { width: colW - 4, ellipsis: true }));
      y += rowH;
      doc.moveTo(left, y - 4).lineTo(left + usableWidth, y - 4).strokeColor("#cccccc").lineWidth(0.5).stroke();
      doc.font("Helvetica").fillColor("#000");
    };

    drawHeader();
    for (const r of items) {
      if (y + rowH > bottom) {
        doc.addPage();
        y = doc.page.margins.top;
        drawHeader();
      }
      doc.fontSize(8).fillColor("#111");
      cols.forEach((c, i) =>
        doc.text(String(display(c, r[c.name] ?? null)), left + i * colW + 2, y, {
          width: colW - 4,
          height: rowH,
          ellipsis: true,
          lineBreak: false,
        }),
      );
      y += rowH;
    }
    if (items.length === 0) {
      doc.fontSize(9).fillColor("#888").text("No records.", left, y + 4);
    }

    doc.end();
  });
}
