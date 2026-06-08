/**
 * Metadata-driven DDL generation.
 *
 * Produces idempotent CREATE TABLE / CREATE INDEX statements for every entity
 * plus the platform support tables. Re-runnable: each statement guards itself
 * with IF NOT EXISTS so `migrate` can be applied repeatedly without error.
 *
 * Record ids are `INT IDENTITY(1,1)` and reference columns are `INT`. NOTE: this
 * is a fresh-DB schema — the additive ALTER path below only adds nullable
 * columns and never converts an existing column's type, so a database already
 * provisioned with the old NVARCHAR id columns cannot be migrated in place;
 * pick up INT ids by creating/seeding a fresh database.
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
  if (col.identity) {
    // The id PK: DB-assigned, monotonically increasing by 1.
    return `${ident(col.name)} INT IDENTITY(1,1) NOT NULL`;
  }
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
    // File bytes live in the DB (keyed by the `file` record id) so blobs travel
    // with the database and stay findable from any backend host/instance — not
    // on a single machine's local disk. The `file` entity row holds the metadata.
    `IF OBJECT_ID(N'[dbo].[_file_blob]', N'U') IS NULL\n` +
      `CREATE TABLE [dbo].[_file_blob] (\n` +
      `  [id] NVARCHAR(80) NOT NULL,\n  [data] VARBINARY(MAX) NOT NULL,\n` +
      `  [mimeType] NVARCHAR(160) NULL,\n  [sizeBytes] INT NOT NULL,\n` +
      `  [sha256] NVARCHAR(64) NULL,\n  [createdAt] NVARCHAR(40) NOT NULL,\n` +
      `  CONSTRAINT [PK__file_blob] PRIMARY KEY ([id])\n);`,
  ];
}

/** Every statement needed to provision the full schema for the given entities. */
export function allStatements(entities: EntityDef[]): string[] {
  const out = [...supportStatements()];
  for (const entity of entities) out.push(...entityStatements(entity));
  return out;
}
