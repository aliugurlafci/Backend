/**
 * Phase 9 — Import / export pipelines.
 *
 * CSV import/export driven by metadata. Export reads enforced records through
 * the domain service (so permissions + projection apply); import creates records
 * one by one, collecting per-row errors rather than failing the whole batch.
 */
import type { RequestContext } from "@/lib/context/types";
import type { MetadataResolver } from "@/lib/metadata/resolver";
import type { FieldValue } from "@/lib/metadata/types";
import type { DomainService } from "@/lib/domain/service";

function csvEscape(value: FieldValue): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Minimal RFC-4180-ish CSV parser (handles quoted fields and escaped quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.length > 0));
}

export async function exportCsv(
  ctx: RequestContext,
  entityName: string,
  metadata: MetadataResolver,
  domain: DomainService,
): Promise<string> {
  const entity = metadata.getEntity(entityName);
  const columns = entity.fields.map((f) => f.name);
  const header = ["id", ...columns].join(",");
  const page = await domain.list(ctx, entityName, { pageSize: 1000 });
  const lines = page.items.map((r) =>
    [csvEscape(r.id), ...columns.map((c) => csvEscape(r[c] ?? null))].join(","),
  );
  return [header, ...lines].join("\n");
}

export interface ImportResult {
  created: string[];
  errors: { row: number; message: string }[];
}

export async function importCsv(
  ctx: RequestContext,
  entityName: string,
  csv: string,
  metadata: MetadataResolver,
  domain: DomainService,
): Promise<ImportResult> {
  const entity = metadata.getEntity(entityName);
  const typeByField = new Map(entity.fields.map((f) => [f.name, f.type]));
  const rows = parseCsv(csv);
  if (!rows.length) return { created: [], errors: [] };

  const header = rows[0];
  const result: ImportResult = { created: [], errors: [] };

  for (let i = 1; i < rows.length; i++) {
    const record: Record<string, unknown> = {};
    header.forEach((col, idx) => {
      if (col === "id") return;
      const raw = rows[i][idx] ?? "";
      if (raw === "") return;
      const type = typeByField.get(col);
      record[col] = type === "number" || type === "currency" ? Number(raw)
        : type === "boolean" ? raw === "true" || raw === "1"
        : raw;
    });
    try {
      const created = await domain.create(ctx, entityName, record);
      result.created.push(created.id);
    } catch (error) {
      result.errors.push({ row: i + 1, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
