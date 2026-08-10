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
import { ENTITY, FIELD } from "@aula/contracts/i18n/entity-labels";
import { enumWord } from "@aula/contracts/i18n/labels";
import { localeText } from "@/lib/i18n/texts";
import { renderEntityXlsx, renderEntityPdf } from "./render-pool";

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Human-friendly cell value in the REQUESTER's language (enum → localized
 * option label, boolean → Evet/Hayır). An export is an answer to one caller —
 * a Turkish user's spreadsheet was arriving with "Yes"/"Draft" cells.
 */
function display(field: FieldDef | undefined, value: FieldValue, locale: string): string | number {
  if (value === null || value === undefined || value === "") return "";
  if (field?.type === "enum") {
    const english = field.options?.find((o) => o.value === value)?.label ?? String(value);
    if (locale === "tr" || locale === "de") return enumWord(String(value), locale) === String(value) ? english : enumWord(String(value), locale);
    return english;
  }
  if (field?.type === "boolean") return value ? localeText(locale, "export.yes") : localeText(locale, "export.no");
  if (typeof value === "number") return round2(value);
  return String(value);
}

/** Localized column header for a field, falling back to the metadata label. */
function headerFor(field: FieldDef, locale: string): string {
  if (locale === "tr" || locale === "de") return FIELD[locale][field.name] ?? field.label;
  return field.label;
}

/** Localized plural entity title, falling back to the metadata plural label. */
function pluralTitle(entity: EntityDef, locale: string): string {
  if (locale === "tr" || locale === "de") return ENTITY[locale][entity.name]?.p ?? entity.pluralLabel;
  return entity.pluralLabel;
}

async function collect(
  ctx: RequestContext,
  entityName: string,
  metadata: MetadataResolver,
  domain: DomainService,
): Promise<{ entity: EntityDef; items: EntityRecord[] }> {
  const entity = metadata.getEntity(entityName);
  // Stream every row: "Export to Excel" on a 5,000-row table used to hand back
  // 200 rows with no warning, because the requested page size was clamped.
  const items: EntityRecord[] = [];
  await domain.listAll(ctx, entityName, {}, (batch) => {
    items.push(...batch);
  });
  return { entity, items };
}

/** Build a real .xlsx workbook (one sheet) for an entity. */
export async function exportXlsx(
  ctx: RequestContext,
  entityName: string,
  metadata: MetadataResolver,
  domain: DomainService,
): Promise<Buffer> {
  const { entity, items } = await collect(ctx, entityName, metadata, domain);

  const locale = ctx.locale;
  const columns = [
    { header: "ID", key: "id", width: 26 },
    ...entity.fields.map((f) => {
      const header = headerFor(f, locale);
      return { header, key: f.name, width: Math.min(40, Math.max(14, header.length + 6)) };
    }),
  ];
  const rows = items.map((r) => {
    const row: Record<string, string | number> = { id: String(r.id) };
    for (const f of entity.fields) row[f.name] = display(f, r[f.name] ?? null, locale);
    return row;
  });

  return renderEntityXlsx({ sheetName: pluralTitle(entity, locale).slice(0, 31), columns, rows });
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
  const locale = ctx.locale;
  const rows = items.map((r) => cols.map((c) => display(c, r[c.name] ?? null, locale)));

  return renderEntityPdf({
    title: pluralTitle(entity, locale),
    count: items.length,
    dateStr: new Date().toISOString().slice(0, 10),
    metaLabel: localeText(locale, "export.recordsMeta", { count: items.length, date: new Date().toISOString().slice(0, 10) }),
    emptyLabel: localeText(locale, "export.noRecords"),
    cols: cols.map((c) => ({ label: headerFor(c, locale) })),
    rows,
  });
}
