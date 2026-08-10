/**
 * SQL dialect abstraction.
 *
 * A {@link SqlDialect} renders the parts of a statement that differ between SQL
 * Server and MySQL — identifier quoting, placeholders, pagination, LIKE/ESCAPE,
 * inserted-id retrieval, DDL types and guards, and schema introspection. The
 * repository, the DDL generator and the migrator are written once against this
 * interface; the concrete driver then binds parameters and executes.
 *
 * The active dialect is selected by `DB_CLIENT` (see `@/lib/config/env`).
 */
import type { DateBucket } from "@/lib/data/query";
import type { ColumnDesc } from "./schema-map";
import type { SqlClient, SqlType } from "./types";

/**
 * Registers a positional parameter and returns its placeholder token. Passed to
 * dialect methods that must both bind values *and* control the order they appear
 * in the statement — critical for MySQL, whose `?` placeholders bind by position
 * (SQL Server's `@pN` bind by name and are order-independent).
 */
export type Binder = (value: unknown, type: SqlType) => string;

/** A CREATE INDEX request in dialect-neutral terms. */
export interface IndexSpec {
  /** Index name. */
  name: string;
  /** Raw (unquoted) table name. */
  table: string;
  /** Raw (unquoted) column names, in key order. */
  columns: string[];
  unique: boolean;
  /**
   * For a nullable UNIQUE index: the business column that may be NULL. SQL Server
   * needs a filtered index (`WHERE col IS NOT NULL`) so multiple NULLs are
   * allowed; MySQL's unique indexes already treat NULLs as distinct, so it
   * ignores this.
   */
  sparseColumn?: string;
}

/** An ALTER TABLE … ADD FOREIGN KEY request in dialect-neutral terms. */
export interface ForeignKeySpec {
  name: string;
  table: string;
  column: string;
  targetTable: string;
  targetColumn: string;
  onDelete: "CASCADE" | "NO ACTION";
}

export interface SqlDialect {
  readonly client: SqlClient;

  // ---- identifiers ----------------------------------------------------------
  /** Quote a bare identifier (`[name]` / `` `name` ``), escaping the quote char. */
  id(name: string): string;
  /** Fully-qualified, quoted table reference (`[dbo].[t]` / `` `t` ``). */
  table(name: string): string;

  // ---- query building -------------------------------------------------------
  /** The placeholder token for the Nth positional parameter (`@p0` / `?`). */
  placeholder(index: number): string;
  /**
   * The clause appended after ORDER BY to page a result set. Binds `offset` and
   * `limit` through `bind` in this dialect's required order (SQL Server:
   * offset-then-limit; MySQL: limit-then-offset) so positional binding stays
   * correct.
   */
  paginate(bind: Binder, offset: number, limit: number): string;
  /** Average of a possibly-integer column as a real number. */
  avgExpr(colExpr: string): string;
  /** A `col LIKE ? ESCAPE '…'` fragment using this dialect's escape char. */
  likeClause(colExpr: string, placeholder: string): string;
  /** Escape LIKE wildcards in a search term for this dialect. */
  escapeLikePattern(term: string): string;
  /** A SELECT returning ≥1 row iff `fromWhere` (e.g. "FROM `t` WHERE …") matches. */
  existsSelect(fromWhere: string): string;
  /**
   * A SELECT that takes an exclusive row lock, so a concurrent transaction
   * serialises behind this one instead of reading a stale value.
   *
   * The whole statement is rendered here because the lock hint's *position*
   * differs: SQL Server puts it after the table (`WITH (UPDLOCK, …)`), MySQL
   * appends `FOR UPDATE` at the end. Both must also lock a *missing* row, or two
   * transactions can each conclude "no row yet" and both insert.
   *
   * MUST be issued inside a transaction — outside one the lock is released
   * immediately and the guarantee is worthless.
   */
  lockingSelect(selectList: string, table: string, whereClause: string): string;
  /**
   * Truncate an ISO-8601 date/datetime *string* column to the start of a period.
   *
   * Dates are stored as ISO strings (see `schema-map`), not date types, so
   * day/month/year are pure prefixes — no `DATEFROMPARTS`/`DATE_FORMAT`, and no
   * per-row cast that would defeat the column's index. Only `quarter` needs
   * arithmetic, and that is the one form that differs between the engines.
   *
   * The returned key is already human-readable ("2026-Q3") and sorts correctly
   * under a plain ORDER BY.
   */
  dateBucketExpr(colExpr: string, bucket: DateBucket): string;
  /** `COUNT(DISTINCT col)`. */
  countDistinctExpr(colExpr: string): string;

  // ---- inserts --------------------------------------------------------------
  /**
   * Clause placed *before* VALUES to return the newly-assigned id in the result
   * recordset (SQL Server `OUTPUT INSERTED.[id] AS [id]`). Empty on MySQL, where
   * the id is read from the driver's `insertId`.
   */
  returningId(idColumn: string): string;
  /**
   * Wrap an explicit-id INSERT so the auto-increment/identity column can be
   * written (SQL Server toggles `IDENTITY_INSERT`; MySQL needs no wrapper).
   */
  wrapIdentityInsert(table: string, insertStatement: string): string;

  // ---- DDL ------------------------------------------------------------------
  /** A full column definition line (`[name] TYPE NOT NULL` / identity column). */
  ddlColumn(col: ColumnDesc): string;
  /** A guarded/idempotent CREATE TABLE with the given column lines + PK on `id`. */
  createTable(table: string, columnLines: string[], pkColumn: string): string;
  /** An ALTER TABLE … ADD for one column (emitted only for genuinely-absent columns). */
  addColumn(table: string, col: ColumnDesc): string;
  /** A CREATE INDEX statement (self-guarded on SQL Server; tolerant-run on MySQL). */
  createIndex(spec: IndexSpec): string;
  /** An ALTER TABLE … ADD FOREIGN KEY statement. */
  foreignKey(fk: ForeignKeySpec): string;
  /** DDL for the platform support tables (migration ledger, seq counter, file blob). */
  supportTableStatements(): string[];
  /** One statement → rows of `{ tbl, col }` for every table + column in the schema. */
  introspectSql(): string;
}

let cached: SqlDialect | null = null;

/** Resolve the process-wide dialect from `DB_CLIENT` (memoised). */
export async function getDialect(): Promise<SqlDialect> {
  if (cached) return cached;
  const { env } = await import("@/lib/config/env");
  cached = await dialectFor(env.DB_CLIENT);
  return cached;
}

/** Build the dialect for a specific client (used by tests and the factory). */
export async function dialectFor(client: SqlClient): Promise<SqlDialect> {
  if (client === "mysql") {
    const { mysqlDialect } = await import("./mysql-dialect");
    return mysqlDialect;
  }
  const { mssqlDialect } = await import("./mssql-dialect");
  return mssqlDialect;
}
