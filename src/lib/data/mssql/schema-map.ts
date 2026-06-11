/**
 * Metadata → MSSQL schema mapping.
 *
 * Translates entity metadata into a concrete physical table shape: one table per
 * entity, system columns plus one typed column per field. Centralised here so
 * DDL generation, INSERT/SELECT binding and the repository all agree on types.
 */
import sql from "mssql";
import type { EntityDef, FieldDef } from "@/lib/metadata/types";

export type ColumnKind = "nvarchar" | "nvarcharmax" | "float" | "decimal" | "bit" | "int";

export interface ColumnDesc {
  /** Logical name (matches the record key). */
  name: string;
  kind: ColumnKind;
  /** NVARCHAR length (ignored for non-string kinds). */
  length: number;
  /** DECIMAL precision/scale (money columns); ignored for other kinds. */
  precision?: number;
  scale?: number;
  notNull: boolean;
  /** A non-unique index is created for filterable/sortable fields. */
  indexed: boolean;
  /** A tenant-scoped filtered unique index is created for unique fields. */
  unique: boolean;
  /** `id` PK only: emitted as `INT IDENTITY(1,1)` and excluded from runtime INSERTs. */
  identity?: boolean;
  /**
   * Stored as INT but represents a record id (the `id` PK or a `reference` field).
   * The app layer keeps ids as strings, so the read path stringifies these while
   * leaving numeric business fields (FLOAT) and `version` (INT) as numbers.
   */
  idLike?: boolean;
}

/** Max key length (in nchars) for an indexable NVARCHAR column (900 bytes). */
const MAX_INDEX_NCHARS = 450;

/** System columns present on every entity table, in physical order. */
export const SYSTEM_COLUMNS: ColumnDesc[] = [
  { name: "id", kind: "int", length: 0, notNull: true, indexed: false, unique: false, identity: true, idLike: true },
  { name: "tenantId", kind: "nvarchar", length: 80, notNull: true, indexed: true, unique: false },
  { name: "orgId", kind: "nvarchar", length: 80, notNull: true, indexed: false, unique: false },
  { name: "ownerId", kind: "nvarchar", length: 80, notNull: false, indexed: false, unique: false },
  { name: "createdAt", kind: "nvarchar", length: 40, notNull: true, indexed: false, unique: false },
  { name: "updatedAt", kind: "nvarchar", length: 40, notNull: true, indexed: false, unique: false },
  { name: "createdBy", kind: "nvarchar", length: 80, notNull: true, indexed: false, unique: false },
  { name: "updatedBy", kind: "nvarchar", length: 80, notNull: true, indexed: false, unique: false },
  { name: "version", kind: "int", length: 0, notNull: true, indexed: false, unique: false },
];

const SYSTEM_NAMES = new Set(SYSTEM_COLUMNS.map((c) => c.name));

function stringLength(field: FieldDef, indexed: boolean): number {
  const base = typeof field.max === "number" && field.max > 0 ? field.max : 400;
  return indexed ? Math.min(base, MAX_INDEX_NCHARS) : Math.min(base, 4000);
}

/** Build the column descriptor for a single metadata field. */
export function fieldColumn(field: FieldDef): ColumnDesc {
  const indexed = Boolean(field.filterable || field.sortable || field.unique);
  const unique = Boolean(field.unique);
  const base = { name: field.name, notNull: false, indexed, unique };

  switch (field.type) {
    case "currency":
      // Money is exact DECIMAL(18,2), never binary FLOAT, so cents never drift.
      return { ...base, kind: "decimal", length: 0, precision: 18, scale: 2 };
    case "number":
    case "percent":
      return { ...base, kind: "float", length: 0 };
    case "boolean":
      return { ...base, kind: "bit", length: 0 };
    case "text":
      // text fields are never indexed in the metadata; store unbounded.
      return { ...base, kind: "nvarcharmax", length: 0, indexed: false, unique: false };
    case "email":
      return { ...base, kind: "nvarchar", length: 320 };
    case "phone":
      return { ...base, kind: "nvarchar", length: 40 };
    case "url":
      return { ...base, kind: "nvarchar", length: indexed ? MAX_INDEX_NCHARS : 2048 };
    case "enum":
      return { ...base, kind: "nvarchar", length: 64 };
    case "reference":
      // Reference values are foreign record ids → INT (idLike: stringified on read).
      return { ...base, kind: "int", length: 0, idLike: true };
    case "date":
    case "datetime":
      return { ...base, kind: "nvarchar", length: 40 };
    case "string":
    default:
      return { ...base, kind: "nvarchar", length: stringLength(field, indexed) };
  }
}

/** All columns (system + fields) for an entity, in physical order. */
export function entityColumns(entity: EntityDef): ColumnDesc[] {
  const fieldCols = entity.fields
    .filter((f) => !SYSTEM_NAMES.has(f.name))
    .map(fieldColumn);
  return [...SYSTEM_COLUMNS, ...fieldCols];
}

/** Map a column kind to the SQL type used for parameter binding. */
export function sqlTypeFor(col: ColumnDesc): sql.ISqlType {
  switch (col.kind) {
    case "float":
      return sql.Float() as unknown as sql.ISqlType;
    case "decimal":
      return sql.Decimal(col.precision ?? 18, col.scale ?? 2) as unknown as sql.ISqlType;
    case "bit":
      return sql.Bit() as unknown as sql.ISqlType;
    case "int":
      return sql.Int() as unknown as sql.ISqlType;
    case "nvarcharmax":
      return sql.NVarChar(sql.MAX) as unknown as sql.ISqlType;
    case "nvarchar":
    default:
      return sql.NVarChar(col.length) as unknown as sql.ISqlType;
  }
}

/** Whether a column stores a record id (id PK or reference) as INT. */
export function isIdLike(col: ColumnDesc): boolean {
  return Boolean(col.idLike);
}

/** Coerce a JS value to the storage representation for its column kind. */
export function toStorage(col: ColumnDesc, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  switch (col.kind) {
    case "float":
    case "decimal":
      return typeof value === "number" ? value : Number(value);
    case "int":
      // "" reaches here for an unset id/reference column → store NULL, not NaN.
      if (value === "") return null;
      return typeof value === "number" ? value : Number(value);
    case "bit":
      return value === true || value === 1 || value === "true";
    default:
      return typeof value === "string" ? value : String(value);
  }
}

/** Quote a SQL identifier (bracketed, with embedded `]` escaped). */
export function ident(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}

/** The physical table name for an entity (bracketed). */
export function tableName(entity: string): string {
  return ident(entity);
}
