/**
 * Excel (.xlsx) and PDF export of entity records.
 *
 * Reads enforced records through the domain service (so permissions + field
 * projection apply) on the main thread, then hands the already-gathered, display-
 * mapped rows to the render worker pool (see `render-pool.ts`) so the CPU-heavy
 * exceljs / pdfkit work doesn't block the event loop. CSV stays in
 * `import-export.ts` for round-trip import.
 *
 * Note: the PDF uses pdfkit's built-in Helvetica (WinAnsi). Latin text renders
 * fine; for full Turkish glyph coverage embed a Unicode TTF via `doc.font(path)`.
 */
import type { RequestContext } from "@/lib/context/types";
import type { MetadataResolver } from "@/lib/metadata/resolver";
import type { DomainService } from "@/lib/domain/service";
import type { EntityDef, EntityRecord, FieldDef, FieldValue } from "@/lib/metadata/types";
import { renderEntityXlsx, renderEntityPdf } from "./render-pool";

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

  const columns = [
    { header: "ID", key: "id", width: 26 },
    ...entity.fields.map((f) => ({ header: f.label, key: f.name, width: Math.min(40, Math.max(14, f.label.length + 6)) })),
  ];
  const rows = items.map((r) => {
    const row: Record<string, string | number> = { id: String(r.id) };
    for (const f of entity.fields) row[f.name] = display(f, r[f.name] ?? null);
    return row;
  });

  return renderEntityXlsx({ sheetName: entity.pluralLabel.slice(0, 31), columns, rows });
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
  const rows = items.map((r) => cols.map((c) => display(c, r[c.name] ?? null)));

  return renderEntityPdf({
    title: entity.pluralLabel,
    count: items.length,
    dateStr: new Date().toISOString().slice(0, 10),
    cols: cols.map((c) => ({ label: c.label })),
    rows,
  });
}
