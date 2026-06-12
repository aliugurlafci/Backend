/**
 * Phase 9 — Import / export pipelines.
 *
 * CSV import/export driven by metadata. Export reads enforced records through
 * the domain service (so permissions + projection apply); import creates records
 * one by one, collecting per-row errors rather than failing the whole batch.
 */
import ExcelJS from "exceljs";
import { BadRequestError } from "@/lib/enforcement/errors";
import { getQueryEngine } from "@/lib/data/store";
import type { RequestContext } from "@/lib/context/types";
import type { MetadataResolver } from "@/lib/metadata/resolver";
import type { FieldValue, FieldDef } from "@/lib/metadata/types";
import type { DomainService } from "@/lib/domain/service";

function csvEscape(value: FieldValue): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  // Neutralise CSV formula injection: a leading =, +, -, @, tab or CR makes
  // Excel/Sheets treat the cell as a formula. Prefix a single quote so it stays
  // literal text when the export is opened.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
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
  /** Header columns that matched no field of the entity (so the user can fix them). */
  ignored?: string[];
}

/** Column-header → field-name aliases supplied by the caller (the localized field
 *  labels the UI shows), so a file headed in the user's language still maps. */
export type ImportAliases = Record<string, string>;

/** Running tallies reported to a progress callback while a batched import runs. */
export interface ImportProgress {
  processed: number;
  created: number;
  failed: number;
}

/** Coerce any ExcelJS cell value to text (rich text, hyperlinks, formula results,
 *  dates → ISO date). */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { text?: string; result?: unknown };
    if (typeof o.text === "string") return o.text;
    if (o.result !== undefined && o.result !== null) return String(o.result);
  }
  return String(v);
}

/** Parse the first worksheet of an .xlsx workbook into rows of string cells —
 *  the same shape `parseCsv` returns — so xlsx imports reuse the CSV pipeline. */
export async function parseXlsx(buffer: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  // exceljs's bundled Buffer type lags Node's generic Buffer<ArrayBufferLike>.
  await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = row.values as unknown[]; // 1-indexed; index 0 is empty
    const cells: string[] = [];
    for (let i = 1; i < vals.length; i++) cells.push(cellText(vals[i]));
    rows.push(cells);
  });
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

/** Coerce a raw cell string to the field's stored value. Enum *labels* and Yes/No
 *  booleans (as written by the xlsx/pdf export) and thousands-separated numbers are
 *  mapped back to their stored form so an exported file round-trips on import. */
function coerceCell(field: FieldDef, raw: string): unknown {
  switch (field.type) {
    case "number":
    case "currency":
    case "percent": {
      const n = Number(raw.replace(/[^\d.\-]/g, "")); // tolerate currency symbols / thousands separators
      return Number.isNaN(n) ? raw : n;
    }
    case "boolean": {
      const low = raw.toLowerCase();
      return low === "true" || low === "1" || low === "yes" || low === "evet" || low === "ja";
    }
    case "enum": {
      const opt = field.options?.find(
        (o) => o.value.toLowerCase() === raw.toLowerCase() || o.label.toLowerCase() === raw.toLowerCase(),
      );
      return opt ? opt.value : raw;
    }
    default:
      return raw;
  }
}

/** Loose match key: lowercased, stripped of spaces and common separators — so
 *  "Annual Revenue" / "annual_revenue" / "annualrevenue" all collide. */
function normKey(s: string): string {
  return s.trim().toLowerCase().replace(/[\s._\-/()]+/g, "");
}

/**
 * Create records from already-parsed rows (header row first). Each header cell is
 * resolved to a WRITABLE field by matching (loosely) its field NAME, its English
 * LABEL, *or* a caller-supplied localized-label alias — so a file headed in the
 * user's own language (e.g. "Ad", "E-posta") imports just as well as an exported
 * CSV (field names) or xlsx (English labels). Non-writable columns (id, computed,
 * read-only, lifecycle) and unrecognised headers are ignored (and reported).
 * Per-row failures are collected with field-level detail rather than aborting.
 */
export async function importRows(
  ctx: RequestContext,
  entityName: string,
  rows: string[][],
  metadata: MetadataResolver,
  domain: DomainService,
  aliases?: ImportAliases,
  onProgress?: (progress: ImportProgress) => void,
): Promise<ImportResult> {
  const entity = metadata.getEntity(entityName);
  const lifecycleField = entity.lifecycle?.field;
  const writable = entity.fields.filter((f) => !f.readOnly && !f.computed && f.name !== lifecycleField);

  // Resolver: normalized(field name | English label | localized alias) → field.
  const lookup = new Map<string, FieldDef>();
  for (const f of writable) {
    lookup.set(normKey(f.name), f);
    lookup.set(normKey(f.label), f);
  }
  const byNameLower = new Map(writable.map((f) => [f.name.toLowerCase(), f] as const));
  for (const [label, name] of Object.entries(aliases ?? {})) {
    const f = byNameLower.get(String(name).toLowerCase());
    if (f) lookup.set(normKey(label), f);
  }

  if (rows.length < 2) return { created: [], errors: [], ignored: [] };

  const ignored: string[] = [];
  const columns: (FieldDef | null)[] = rows[0].map((h) => {
    const header = h.trim();
    if (!header) return null;
    const field = lookup.get(normKey(header));
    if (!field) {
      if (normKey(header) !== "id") ignored.push(header);
      return null;
    }
    return field;
  });

  // Build the input records, then bulk-create them in ONE pass via the query
  // engine — no per-row domain events, so a 20k-row import doesn't fire 20k
  // automations / search re-indexes / webhooks (which would time out → 500).
  const inputs: Record<string, unknown>[] = [];
  const rowNumbers: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const record: Record<string, unknown> = {};
    columns.forEach((field, idx) => {
      if (!field) return;
      const raw = (rows[i][idx] ?? "").trim();
      if (raw === "") return;
      record[field.name] = coerceCell(field, raw);
    });
    inputs.push(record);
    rowNumbers.push(i + 1); // 1-based row number in the file (header is row 1)
  }

  const qe = await getQueryEngine();
  const created: string[] = [];
  const errors: { row: number; message: string }[] = [];

  // Process in batches so a huge import (a) can report progress to a background
  // job and (b) commits incrementally rather than as one monster statement.
  // Each batch's uniqueness preload re-reads already-committed rows, so a
  // duplicate that spans two batches is still caught.
  const BATCH = 1000;
  onProgress?.({ processed: 0, created: 0, failed: 0 });
  for (let start = 0; start < inputs.length; start += BATCH) {
    const slice = inputs.slice(start, start + BATCH);
    const res = await qe.bulkCreate(ctx, entityName, slice);
    for (const r of res.created) created.push(String(r.id));
    for (const e of res.errors) {
      errors.push({ row: rowNumbers[start + e.index] ?? start + e.index + 1, message: e.message });
    }
    onProgress?.({
      processed: Math.min(start + slice.length, inputs.length),
      created: created.length,
      failed: errors.length,
    });
  }
  return { created, errors, ignored };
}

export async function importCsv(
  ctx: RequestContext,
  entityName: string,
  csv: string,
  metadata: MetadataResolver,
  domain: DomainService,
  aliases?: ImportAliases,
): Promise<ImportResult> {
  return importRows(ctx, entityName, parseCsv(csv), metadata, domain, aliases);
}

/** Parse an uploaded import payload (base64 .xlsx or raw CSV text) into rows of
 *  string cells — shared by the synchronous import endpoints and the background
 *  import job, so both read the file the same way. */
export async function parseImportFile(payload: { xlsx?: string; csv?: string }): Promise<string[][]> {
  if (payload.xlsx) {
    try {
      return await parseXlsx(Buffer.from(payload.xlsx, "base64"));
    } catch {
      // A corrupt file or an old .xls (BIFF, which exceljs can't read) — surface
      // a clear 400 instead of an opaque 500.
      throw new BadRequestError("Couldn't read the Excel file. Save it as a modern .xlsx workbook and try again.");
    }
  }
  return parseCsv(payload.csv ?? "");
}

export async function importXlsx(
  ctx: RequestContext,
  entityName: string,
  base64: string,
  metadata: MetadataResolver,
  domain: DomainService,
  aliases?: ImportAliases,
): Promise<ImportResult> {
  const rows = await parseImportFile({ xlsx: base64 });
  return importRows(ctx, entityName, rows, metadata, domain, aliases);
}

/**
 * Build an empty import TEMPLATE for an entity: a single header row of its
 * writable field labels (each column = one field), as a real .xlsx workbook or a
 * CSV. Users fill the rows beneath and re-import — the headers round-trip because
 * import resolves field names / labels / localized aliases.
 */
export async function buildImportTemplate(
  entityName: string,
  metadata: MetadataResolver,
  format: "xlsx" | "csv",
): Promise<{ buffer: Buffer; contentType: string; ext: "xlsx" | "csv" }> {
  const entity = metadata.getEntity(entityName);
  const headers = entity.fields
    .filter((f) => !f.readOnly && !f.computed && f.name !== entity.lifecycle?.field)
    .map((f) => f.label);

  if (format === "csv") {
    const csv = "﻿" + headers.map((h) => csvEscape(h)).join(",") + "\n";
    return { buffer: Buffer.from(csv, "utf8"), contentType: "text/csv; charset=utf-8", ext: "csv" };
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "Aula CRM";
  const ws = wb.addWorksheet(entity.pluralLabel.slice(0, 31));
  ws.columns = headers.map((h) => ({ header: h, key: h, width: Math.min(40, Math.max(14, h.length + 6)) }));
  ws.getRow(1).font = { bold: true };
  const buffer = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  return {
    buffer,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: "xlsx",
  };
}
