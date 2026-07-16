/**
 * SQL Server dialect.
 *
 * Renders the T-SQL forms: bracketed identifiers, `@pN` placeholders, OFFSET/
 * FETCH paging, `OUTPUT INSERTED` for the assigned id, `IDENTITY(1,1)` columns,
 * `IDENTITY_INSERT` for explicit-id seeding, guarded (idempotent) DDL, and
 * `sys.*` introspection.
 */
import type { ColumnDesc } from "./schema-map";
import type { SqlDialect, IndexSpec, ForeignKeySpec } from "./dialect";

/** Escape char used in all LIKE patterns — `!` avoids backslash string-literal
 *  ambiguity that differs between the two engines. */
const ESC = "!";

function ddlType(col: ColumnDesc): string {
  switch (col.kind) {
    case "float":
      return "FLOAT";
    case "decimal":
      return `DECIMAL(${col.precision ?? 18},${col.scale ?? 2})`;
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

export const mssqlDialect: SqlDialect = {
  client: "mssql",

  id(name) {
    return `[${name.replace(/]/g, "]]")}]`;
  },
  table(name) {
    return `[dbo].${this.id(name)}`;
  },

  placeholder(index) {
    return `@p${index}`;
  },
  paginate(bind, offset, limit) {
    const o = bind(offset, { kind: "int" });
    const l = bind(limit, { kind: "int" });
    return `OFFSET ${o} ROWS FETCH NEXT ${l} ROWS ONLY`;
  },
  avgExpr(colExpr) {
    return `AVG(CAST(${colExpr} AS FLOAT))`;
  },
  likeClause(colExpr, placeholder) {
    return `${colExpr} LIKE ${placeholder} ESCAPE '${ESC}'`;
  },
  escapeLikePattern(term) {
    // `[` is a wildcard (character class) in T-SQL LIKE, so it must be escaped.
    return term.replace(/[!%_[]/g, (ch) => `${ESC}${ch}`);
  },
  existsSelect(fromWhere) {
    return `SELECT TOP 1 1 AS x ${fromWhere}`;
  },

  returningId(idColumn) {
    return `OUTPUT INSERTED.${this.id(idColumn)} AS ${this.id(idColumn)}`;
  },
  wrapIdentityInsert(table, insertStatement) {
    return `SET IDENTITY_INSERT ${table} ON; ${insertStatement}; SET IDENTITY_INSERT ${table} OFF;`;
  },

  ddlColumn(col) {
    if (col.identity) {
      // The id PK: DB-assigned, monotonically increasing by 1.
      return `${this.id(col.name)} INT IDENTITY(1,1) NOT NULL`;
    }
    return `${this.id(col.name)} ${ddlType(col)} ${col.notNull ? "NOT NULL" : "NULL"}`;
  },
  createTable(table, columnLines, pkColumn) {
    const q = this.table(table);
    return (
      `IF OBJECT_ID(N'${q}', N'U') IS NULL\n` +
      `CREATE TABLE ${q} (\n  ${columnLines.join(",\n  ")},\n  ` +
      `CONSTRAINT [PK_${table}] PRIMARY KEY (${this.id(pkColumn)})\n);`
    );
  },
  addColumn(table, col) {
    return `ALTER TABLE ${this.table(table)} ADD ${this.ddlColumn(col)};`;
  },
  createIndex(spec: IndexSpec) {
    const cols = spec.columns.map((c) => this.id(c)).join(",");
    const filter = spec.unique && spec.sparseColumn ? ` WHERE ${this.id(spec.sparseColumn)} IS NOT NULL` : "";
    const body =
      `CREATE ${spec.unique ? "UNIQUE " : ""}INDEX [${spec.name}] ON ${this.table(spec.table)} ` +
      `(${cols})${filter}`;
    return (
      `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'${spec.name}' ` +
      `AND object_id = OBJECT_ID(N'${this.table(spec.table)}'))\n${body};`
    );
  },
  foreignKey(fk: ForeignKeySpec) {
    return (
      `IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'${fk.name}')\n` +
      `ALTER TABLE ${this.table(fk.table)} ADD CONSTRAINT [${fk.name}] ` +
      `FOREIGN KEY (${this.id(fk.column)}) REFERENCES ${this.table(fk.targetTable)}(${this.id(fk.targetColumn)}) ` +
      `ON DELETE ${fk.onDelete};`
    );
  },
  supportTableStatements() {
    return [
      `IF OBJECT_ID(N'[dbo].[_schema_migrations]', N'U') IS NULL\n` +
        `CREATE TABLE [dbo].[_schema_migrations] (\n` +
        `  [version] INT NOT NULL,\n  [appliedAt] NVARCHAR(40) NOT NULL,\n` +
        `  CONSTRAINT [PK__schema_migrations] PRIMARY KEY ([version])\n);`,
      `IF OBJECT_ID(N'[dbo].[_seq_counter]', N'U') IS NULL\n` +
        `CREATE TABLE [dbo].[_seq_counter] (\n` +
        `  [tenantId] NVARCHAR(80) NOT NULL,\n  [prefix] NVARCHAR(40) NOT NULL,\n  [value] INT NOT NULL,\n` +
        `  CONSTRAINT [PK__seq_counter] PRIMARY KEY ([tenantId],[prefix])\n);`,
      `IF OBJECT_ID(N'[dbo].[_file_blob]', N'U') IS NULL\n` +
        `CREATE TABLE [dbo].[_file_blob] (\n` +
        `  [id] NVARCHAR(80) NOT NULL,\n  [data] VARBINARY(MAX) NOT NULL,\n` +
        `  [mimeType] NVARCHAR(160) NULL,\n  [sizeBytes] INT NOT NULL,\n` +
        `  [sha256] NVARCHAR(64) NULL,\n  [createdAt] NVARCHAR(40) NOT NULL,\n` +
        `  CONSTRAINT [PK__file_blob] PRIMARY KEY ([id])\n);`,
    ];
  },
  introspectSql() {
    return (
      `SELECT t.name AS tbl, c.name AS col\n` +
      `  FROM sys.tables t\n` +
      `  JOIN sys.columns c ON c.object_id = t.object_id\n` +
      ` WHERE t.schema_id = SCHEMA_ID('dbo')`
    );
  },
};
