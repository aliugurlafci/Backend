/**
 * Metadata-driven DDL generation.
 *
 * Produces idempotent CREATE TABLE / CREATE INDEX statements for every entity
 * plus the platform support tables. Re-runnable: each statement guards itself
 * with IF NOT EXISTS so `migrate` can be applied repeatedly without error.
 */
import type { EntityDef } from "@/lib/metadata/types";
import { entityColumns, ident, type ColumnDesc } from "./schema-map";

function ddlColumnType(col: ColumnDesc): string {
  switch (col.kind) {
    case "float":
      return "FLOAT";
    case "bit":
      return "BIT";
    case "int":
      return "INT";
    case "nvarcharmax":
      return "NVARCHAR(MAX)";
    case "nvarchar":
    default:
      return `NVARCHAR(${col.length})`;
  }
}

function columnDdl(col: ColumnDesc): string {
  return `${ident(col.name)} ${ddlColumnType(col)} ${col.notNull ? "NOT NULL" : "NULL"}`;
}

/** Wrap a CREATE INDEX in an existence guard. */
function guardedIndex(indexName: string, entity: string, body: string): string {
  return (
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'${indexName}' ` +
    `AND object_id = OBJECT_ID(N'[dbo].${ident(entity)}'))\n${body};`
  );
}

/** All statements needed to provision one entity's table + indexes. */
export function entityStatements(entity: EntityDef): string[] {
  const cols = entityColumns(entity);
  const t = entity.name;
  const stmts: string[] = [];

  const columnLines = cols.map(columnDdl).join(",\n  ");
  stmts.push(
    `IF OBJECT_ID(N'[dbo].${ident(t)}', N'U') IS NULL\n` +
      `CREATE TABLE [dbo].${ident(t)} (\n  ${columnLines},\n  ` +
      `CONSTRAINT [PK_${t}] PRIMARY KEY (${ident("id")})\n);`,
  );

  // Additive evolution: add any nullable field column missing from an existing
  // table (declaring a new field on an already-provisioned entity). System
  // columns are NOT NULL and always present, so they're skipped. Guarded by
  // COL_LENGTH so this is idempotent and a no-op on freshly created tables.
  for (const col of cols) {
    if (col.notNull) continue;
    stmts.push(
      `IF COL_LENGTH(N'[dbo].${ident(t)}', N'${col.name.replace(/'/g, "''")}') IS NULL\n` +
        `ALTER TABLE [dbo].${ident(t)} ADD ${columnDdl(col)};`,
    );
  }

  // Composite scope index (every read is tenant+org scoped, sorted by createdAt).
  stmts.push(
    guardedIndex(
      `IX_${t}__scope`,
      t,
      `CREATE INDEX [IX_${t}__scope] ON [dbo].${ident(t)} ` +
        `(${ident("tenantId")},${ident("orgId")},${ident("createdAt")})`,
    ),
  );

  for (const col of cols) {
    if (col.name === "tenantId" || col.name === "orgId") continue;
    if (col.unique) {
      stmts.push(
        guardedIndex(
          `UX_${t}_${col.name}`,
          t,
          `CREATE UNIQUE INDEX [UX_${t}_${col.name}] ON [dbo].${ident(t)} ` +
            `(${ident("tenantId")},${ident("orgId")},${ident(col.name)}) WHERE ${ident(col.name)} IS NOT NULL`,
        ),
      );
    } else if (col.indexed) {
      stmts.push(
        guardedIndex(
          `IX_${t}_${col.name}`,
          t,
          `CREATE INDEX [IX_${t}_${col.name}] ON [dbo].${ident(t)} ` +
            `(${ident("tenantId")},${ident("orgId")},${ident(col.name)})`,
        ),
      );
    }
  }

  return stmts;
}

/** Platform support tables (schema-version ledger + document number counters). */
export function supportStatements(): string[] {
  return [
    `IF OBJECT_ID(N'[dbo].[_schema_migrations]', N'U') IS NULL\n` +
      `CREATE TABLE [dbo].[_schema_migrations] (\n` +
      `  [version] INT NOT NULL,\n  [appliedAt] NVARCHAR(40) NOT NULL,\n` +
      `  CONSTRAINT [PK__schema_migrations] PRIMARY KEY ([version])\n);`,
    `IF OBJECT_ID(N'[dbo].[_seq_counter]', N'U') IS NULL\n` +
      `CREATE TABLE [dbo].[_seq_counter] (\n` +
      `  [tenantId] NVARCHAR(80) NOT NULL,\n  [prefix] NVARCHAR(40) NOT NULL,\n  [value] INT NOT NULL,\n` +
      `  CONSTRAINT [PK__seq_counter] PRIMARY KEY ([tenantId],[prefix])\n);`,
  ];
}

/** Every statement needed to provision the full schema for the given entities. */
export function allStatements(entities: EntityDef[]): string[] {
  const out = [...supportStatements()];
  for (const entity of entities) out.push(...entityStatements(entity));
  return out;
}
