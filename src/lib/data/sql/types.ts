/**
 * Dialect-neutral SQL types shared by the query builder, the drivers and the
 * dialects.
 *
 * A {@link SqlType} is an abstract description of a bound parameter's type. The
 * repository/query builder tags every parameter with one of these (derived from
 * the column descriptor); each concrete driver then maps it to its native
 * binding type — `mssql`'s `sql.ISqlType` or a plain value for `mysql2`.
 */

/** Abstract type of a bound parameter (driver-neutral). */
export type SqlType =
  | { kind: "int" }
  | { kind: "bigint" }
  | { kind: "float" }
  | { kind: "decimal"; precision: number; scale: number }
  | { kind: "bit" }
  /** Bounded unicode string → NVARCHAR(n) / VARCHAR(n). */
  | { kind: "string"; length: number }
  /** Unbounded unicode text → NVARCHAR(MAX) / LONGTEXT. */
  | { kind: "text" }
  /** Binary blob → VARBINARY(MAX) / LONGBLOB. */
  | { kind: "binary" };

/** Convenience constructors for raw (non-column) parameter types. */
export const T = {
  int: { kind: "int" } as SqlType,
  bigint: { kind: "bigint" } as SqlType,
  bit: { kind: "bit" } as SqlType,
  binary: { kind: "binary" } as SqlType,
  text: { kind: "text" } as SqlType,
  string: (length: number): SqlType => ({ kind: "string", length }),
  decimal: (precision: number, scale: number): SqlType => ({ kind: "decimal", precision, scale }),
} as const;

/** A single positional parameter: its value plus its abstract type. */
export interface BoundParam {
  value: unknown;
  type: SqlType;
}

/**
 * Normalised result of a query, uniform across drivers.
 *  - `rows`     — the returned recordset (empty for non-SELECT).
 *  - `rowsAffected` — rows changed by an INSERT/UPDATE/DELETE.
 *  - `insertId` — the last auto-increment id assigned (MySQL); undefined on
 *                 MSSQL, where an inserted id is read back via an OUTPUT column.
 */
export interface QueryResult {
  rows: Array<Record<string, unknown>>;
  rowsAffected: number;
  insertId?: number;
}

/** Which SQL backend is in use. */
export type SqlClient = "mssql" | "mysql";
