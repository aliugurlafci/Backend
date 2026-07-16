/**
 * SQL driver abstraction.
 *
 * A {@link SqlDriver} owns the connection pool and executes statements for one
 * backend (SQL Server via `mssql`, MySQL via `mysql2`). It normalises the two
 * very different client APIs — named vs positional binding, `Transaction` vs
 * `PoolConnection`, `recordset` vs `[rows, fields]` — behind one interface so
 * the repository, DDL generator and migrator are written once.
 *
 * The active driver is selected by `DB_CLIENT` (see `@/lib/config/env`) and
 * pinned to `globalThis` so dev reloads (tsx watch) don't leak pools.
 */
import type { BoundParam, QueryResult, SqlClient } from "./types";

export interface SqlDriver {
  readonly client: SqlClient;
  /** Max pooled connections — the concurrency ceiling for parallel DB work. */
  readonly poolMax: number;

  /** Run a parameterised statement, binding `params` positionally. */
  query(text: string, params: BoundParam[]): Promise<QueryResult>;
  /** Run a parameterless statement/batch (DDL). */
  exec(text: string): Promise<void>;
  /**
   * Run `fn` atomically. Every {@link query} issued (on this driver) while `fn`
   * runs binds to the transaction's connection, so they commit/rollback
   * together. Nested calls join the outer transaction. A transaction chosen as a
   * deadlock victim / lock-timeout casualty is rolled back and retried with
   * backoff.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  /** Create the target database if it doesn't exist yet (best-effort). */
  ensureDatabase(): Promise<void>;
  /** Close the pool (graceful shutdown / tests). */
  close(): Promise<void>;

  /** Is this a transient deadlock / lock-timeout worth retrying? */
  isDeadlock(err: unknown): boolean;
  /** Is this an "object already exists" error (idempotent DDL re-run)? */
  isAlreadyExists(err: unknown): boolean;
}

/** Retries for a transaction chosen as a deadlock victim / lock-timeout casualty. */
export const MAX_DEADLOCK_RETRIES = 4;

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Randomised backoff (ms) for the Nth deadlock retry. */
export const retryBackoff = (attempt: number): number =>
  20 * (attempt + 1) + Math.floor(Math.random() * 30);

interface DriverHolder {
  driver: SqlDriver | null;
}

const globalRef = globalThis as unknown as { __aulaDriver?: DriverHolder };
const holder: DriverHolder = (globalRef.__aulaDriver ??= { driver: null });

/** Resolve the process-wide SQL driver selected by `DB_CLIENT` (memoised). */
export async function getDriver(): Promise<SqlDriver> {
  if (holder.driver) return holder.driver;
  const { env } = await import("@/lib/config/env");
  if (env.DB_CLIENT === "mysql") {
    holder.driver = (await import("./mysql-driver")).mysqlDriver;
  } else {
    holder.driver = (await import("./mssql-driver")).mssqlDriver;
  }
  return holder.driver;
}

/** Close and forget the active driver (tests). */
export async function closeDriver(): Promise<void> {
  if (holder.driver) {
    await holder.driver.close();
    holder.driver = null;
  }
}
