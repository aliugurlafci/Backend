/**
 * Metadata-driven DDL generation (dialect-driven).
 *
 * Produces CREATE TABLE / CREATE INDEX / ALTER … ADD / foreign-key statements
 * for every entity plus the platform support tables. Every statement is
 * idempotent — either self-guarded (SQL Server) or run tolerantly by the
 * migrator (MySQL), so `migrate` can be applied repeatedly without error.
 *
 * Record ids are the dialect's auto-increment id and reference columns are INT.
 */
import type { EntityDef } from "@/lib/metadata/types";
import type { SqlDialect } from "./dialect";
import { entityColumns, type ColumnDesc } from "./schema-map";

/** The CREATE TABLE statement for one entity (all columns + PK on `id`). */
export function createTableStatement(entity: EntityDef, dialect: SqlDialect): string {
  const lines = entityColumns(entity).map((c) => dialect.ddlColumn(c));
  return dialect.createTable(entity.name, lines, "id");
}

/** All index statements for an entity: the composite scope index + per-field
 *  unique/non-unique indexes. */
export function indexStatements(entity: EntityDef, dialect: SqlDialect): string[] {
  const t = entity.name;
  const stmts: string[] = [];
  // Composite scope index (every read is tenant+org scoped, sorted by createdAt).
  stmts.push(
    dialect.createIndex({
      name: `IX_${t}__scope`,
      table: t,
      columns: ["tenantId", "orgId", "createdAt"],
      unique: false,
    }),
  );
  for (const col of entityColumns(entity)) {
    const s = columnIndexStatement(entity, dialect, col);
    if (s) stmts.push(s);
  }
  return stmts;
}

/** The index statement for a single business column, or null if it needs none. */
function columnIndexStatement(entity: EntityDef, dialect: SqlDialect, col: ColumnDesc): string | null {
  const t = entity.name;
  if (col.name === "tenantId" || col.name === "orgId") return null;
  if (col.unique) {
    return dialect.createIndex({
      name: `UX_${t}_${col.name}`,
      table: t,
      columns: ["tenantId", "orgId", col.name],
      unique: true,
      sparseColumn: col.name,
    });
  }
  if (col.indexed) {
    return dialect.createIndex({
      name: `IX_${t}_${col.name}`,
      table: t,
      columns: ["tenantId", "orgId", col.name],
      unique: false,
    });
  }
  return null;
}

/** Index statements for just the named (newly-added) columns — used by the
 *  boot reconcile so a new indexed/unique field gets its index without a full sweep. */
export function columnIndexStatements(entity: EntityDef, dialect: SqlDialect, columns: Set<string>): string[] {
  const stmts: string[] = [];
  for (const col of entityColumns(entity)) {
    if (!columns.has(col.name)) continue;
    const s = columnIndexStatement(entity, dialect, col);
    if (s) stmts.push(s);
  }
  return stmts;
}

/** Table + index statements for one entity (used for offline DDL preview/tests). */
export function entityStatements(entity: EntityDef, dialect: SqlDialect): string[] {
  return [createTableStatement(entity, dialect), ...indexStatements(entity, dialect)];
}

/**
 * Foreign-key constraints for an entity's reference fields. The parent→child
 * edge of a line-item entity cascades on delete; every other reference uses NO
 * ACTION. Only references whose target entity has a table are emitted.
 */
export function foreignKeyStatements(entity: EntityDef, knownEntities: Set<string>, dialect: SqlDialect): string[] {
  const t = entity.name;
  const stmts: string[] = [];
  for (const f of entity.fields) {
    if (f.type !== "reference" || !f.referenceEntity) continue;
    if (!knownEntities.has(f.referenceEntity)) continue; // target must be a real table
    const target = f.referenceEntity;
    const isParentEdge = entity.parent?.entity === target && entity.parent?.field === f.name;
    // Self-references can't cascade; parent edges do; everything else NO ACTION.
    const onDelete = isParentEdge && target !== t ? "CASCADE" : "NO ACTION";
    stmts.push(
      dialect.foreignKey({
        name: `FK_${t}_${f.name}`,
        table: t,
        column: f.name,
        targetTable: target,
        targetColumn: "id",
        onDelete,
      }),
    );
  }
  return stmts;
}

/** All FK statements across the given entities (run after every table exists). */
export function allForeignKeyStatements(entities: EntityDef[], dialect: SqlDialect): string[] {
  const known = new Set(entities.map((e) => e.name));
  const out: string[] = [];
  for (const entity of entities) out.push(...foreignKeyStatements(entity, known, dialect));
  return out;
}

/**
 * ALTER … ADD statements for the nullable field columns absent from a table that
 * already exists — so the boot reconcile self-heals a newly-declared field. System
 * columns are NOT NULL and always present, so they're never added here.
 */
export function missingColumnStatements(entity: EntityDef, existing: Set<string>, dialect: SqlDialect): string[] {
  const stmts: string[] = [];
  for (const col of entityColumns(entity)) {
    if (col.notNull) continue;
    if (existing.has(col.name)) continue;
    stmts.push(dialect.addColumn(entity.name, col));
  }
  return stmts;
}

/** Platform support tables (schema-version ledger, sequence counters, file blobs). */
export function supportStatements(dialect: SqlDialect): string[] {
  return dialect.supportTableStatements();
}

/** Every statement needed to provision the full schema for the given entities. */
export function allStatements(entities: EntityDef[], dialect: SqlDialect): string[] {
  const out = [...supportStatements(dialect)];
  for (const entity of entities) out.push(...entityStatements(entity, dialect));
  return out;
}
