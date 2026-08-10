/**
 * MySQL dialect (targets MySQL 8.0+ / MariaDB 10.2+).
 *
 * Renders backtick identifiers, `?` positional placeholders, LIMIT/OFFSET
 * paging, `AUTO_INCREMENT` id columns (the assigned id is read from the driver's
 * `insertId`, so no OUTPUT clause is needed), `CREATE TABLE IF NOT EXISTS`, and
 * `information_schema` introspection. Indexes and foreign keys are created with
 * plain statements and run tolerantly by the migrator (MySQL has no inline
 * "if not exists" for those). Unicode is handled by the utf8mb4 table charset;
 * a UNIQUE index already treats NULLs as distinct, so no filtered index is
 * needed for sparse-unique fields.
 */
import type { ColumnDesc } from "./schema-map";
import type { SqlDialect, IndexSpec, ForeignKeySpec } from "./dialect";

const ESC = "!";

function ddlType(col: ColumnDesc): string {
  switch (col.kind) {
    case "float":
      return "DOUBLE";
    case "decimal":
      return `DECIMAL(${col.precision ?? 18},${col.scale ?? 2})`;
    case "bit":
      // TINYINT(1) is MySQL's boolean; the repository coerces it back to a JS
      // boolean on read so it matches SQL Server's BIT.
      return "TINYINT(1)";
    case "int":
      return "INT";
    case "nvarcharmax":
      return "LONGTEXT";
    case "nvarchar":
    default:
      return `VARCHAR(${col.length})`;
  }
}

export const mysqlDialect: SqlDialect = {
  client: "mysql",

  id(name) {
    return `\`${name.replace(/`/g, "``")}\``;
  },
  table(name) {
    return this.id(name);
  },

  placeholder() {
    return "?";
  },
  paginate(bind, offset, limit) {
    // MySQL syntax is LIMIT <count> OFFSET <offset>; bind in that order so the
    // positional `?` params line up.
    const l = bind(limit, { kind: "int" });
    const o = bind(offset, { kind: "int" });
    return `LIMIT ${l} OFFSET ${o}`;
  },
  avgExpr(colExpr) {
    // AVG over an INT column already yields an exact DECIMAL in MySQL, so no cast.
    return `AVG(${colExpr})`;
  },
  likeClause(colExpr, placeholder) {
    return `${colExpr} LIKE ${placeholder} ESCAPE '${ESC}'`;
  },
  escapeLikePattern(term) {
    // `[` is a literal in MySQL LIKE (only `%` and `_` are wildcards).
    return term.replace(/[!%_]/g, (ch) => `${ESC}${ch}`);
  },
  existsSelect(fromWhere) {
    return `SELECT 1 AS x ${fromWhere} LIMIT 1`;
  },
  lockingSelect(selectList, table, whereClause) {
    // Under InnoDB's default REPEATABLE READ, `FOR UPDATE` performs a *current*
    // read (bypassing the transaction snapshot) and gap-locks the range — so a
    // row that does not exist yet is locked too, and two transactions cannot
    // both insert it. That gap lock is the MySQL counterpart of MSSQL HOLDLOCK.
    return `SELECT ${selectList} FROM ${table} WHERE ${whereClause} FOR UPDATE`;
  },
  dateBucketExpr(colExpr, bucket) {
    switch (bucket) {
      case "year":
        return `LEFT(${colExpr}, 4)`;
      case "month":
        return `LEFT(${colExpr}, 7)`;
      case "day":
        return `LEFT(${colExpr}, 10)`;
      case "quarter":
        // Same shape as T-SQL, but MySQL concatenates with CONCAT (`+` is
        // arithmetic) and needs DIV for integer division (`/` yields a decimal).
        return `CONCAT(LEFT(${colExpr}, 4), '-Q', (CAST(SUBSTRING(${colExpr}, 6, 2) AS UNSIGNED) + 2) DIV 3)`;
    }
  },
  countDistinctExpr(colExpr) {
    return `COUNT(DISTINCT ${colExpr})`;
  },

  returningId() {
    // The assigned id is read from the driver's insertId — no OUTPUT clause.
    return "";
  },
  wrapIdentityInsert(_table, insertStatement) {
    // AUTO_INCREMENT columns accept explicit values directly; no toggle needed.
    return insertStatement;
  },

  ddlColumn(col) {
    if (col.identity) {
      return `${this.id(col.name)} INT NOT NULL AUTO_INCREMENT`;
    }
    return `${this.id(col.name)} ${ddlType(col)} ${col.notNull ? "NOT NULL" : "NULL"}`;
  },
  createTable(table, columnLines, pkColumn) {
    return (
      `CREATE TABLE IF NOT EXISTS ${this.table(table)} (\n  ${columnLines.join(",\n  ")},\n  ` +
      `PRIMARY KEY (${this.id(pkColumn)})\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`
    );
  },
  addColumn(table, col) {
    return `ALTER TABLE ${this.table(table)} ADD COLUMN ${this.ddlColumn(col)};`;
  },
  createIndex(spec: IndexSpec) {
    const cols = spec.columns.map((c) => this.id(c)).join(",");
    return `CREATE ${spec.unique ? "UNIQUE " : ""}INDEX ${this.id(spec.name)} ON ${this.table(spec.table)} (${cols});`;
  },
  foreignKey(fk: ForeignKeySpec) {
    return (
      `ALTER TABLE ${this.table(fk.table)} ADD CONSTRAINT ${this.id(fk.name)} ` +
      `FOREIGN KEY (${this.id(fk.column)}) REFERENCES ${this.table(fk.targetTable)}(${this.id(fk.targetColumn)}) ` +
      `ON DELETE ${fk.onDelete};`
    );
  },
  supportTableStatements() {
    return [
      `CREATE TABLE IF NOT EXISTS ${this.table("_schema_migrations")} (\n` +
        `  \`version\` INT NOT NULL,\n  \`appliedAt\` VARCHAR(40) NOT NULL,\n` +
        `  PRIMARY KEY (\`version\`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
      `CREATE TABLE IF NOT EXISTS ${this.table("_seq_counter")} (\n` +
        `  \`tenantId\` VARCHAR(80) NOT NULL,\n  \`prefix\` VARCHAR(40) NOT NULL,\n  \`value\` INT NOT NULL,\n` +
        `  PRIMARY KEY (\`tenantId\`,\`prefix\`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
      `CREATE TABLE IF NOT EXISTS ${this.table("_file_blob")} (\n` +
        `  \`id\` VARCHAR(80) NOT NULL,\n  \`data\` LONGBLOB NOT NULL,\n` +
        `  \`mimeType\` VARCHAR(160) NULL,\n  \`sizeBytes\` INT NOT NULL,\n` +
        `  \`sha256\` VARCHAR(64) NULL,\n  \`createdAt\` VARCHAR(40) NOT NULL,\n` +
        `  PRIMARY KEY (\`id\`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
    ];
  },
  introspectSql() {
    return (
      `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS col\n` +
      `  FROM information_schema.columns\n` +
      ` WHERE TABLE_SCHEMA = DATABASE()`
    );
  },
};
