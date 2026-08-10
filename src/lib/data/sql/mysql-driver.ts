/**
 * MySQL driver (mysql2).
 *
 * A single process-wide connection pool pinned to `globalThis` so dev reloads
 * (tsx watch) don't leak pools. Binds `?` parameters positionally, routes
 * queries to the active transaction's `PoolConnection` (via AsyncLocalStorage)
 * when one is open, and retries deadlock victims. DECIMAL is returned as a JS
 * number (`decimalNumbers`) and unicode is handled by the utf8mb4 charset, so
 * reads match the SQL Server driver's shapes.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import mysql from "mysql2/promise";
import type { Connection, Pool, PoolConnection, PoolOptions, ResultSetHeader } from "mysql2/promise";
import { env } from "@/lib/config/env";
import { logger } from "@/lib/observability/logger";
import { metrics } from "@/lib/observability/metrics";
import type { SqlDriver } from "./driver";
import { MAX_DEADLOCK_RETRIES, delay, retryBackoff } from "./driver";
import type { BoundParam, QueryResult } from "./types";

function baseOptions(): PoolOptions {
  return {
    host: env.MYSQL_HOST,
    port: env.MYSQL_PORT,
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    charset: "utf8mb4",
    // DECIMAL as a JS number (matches node-mssql, whose DECIMAL is a number too).
    decimalNumbers: true,
    // We store timestamps as ISO strings in VARCHAR columns, so no Date coercion.
    dateStrings: true,
    ssl: env.MYSQL_SSL ? {} : undefined,
  };
}

function poolConfig(): PoolOptions {
  return {
    ...baseOptions(),
    database: env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: env.MYSQL_POOL_MAX,
    maxIdle: env.MYSQL_POOL_MIN,
    idleTimeout: 30_000,
    enableKeepAlive: true,
  };
}

interface PoolHolder {
  pool: Pool | null;
}

const globalRef = globalThis as unknown as { __aulaMysqlPool?: PoolHolder };
const holder: PoolHolder = (globalRef.__aulaMysqlPool ??= { pool: null });

function getPool(): Pool {
  if (holder.pool) return holder.pool;
  holder.pool = mysql.createPool(poolConfig());
  logger.info("mysql pool created", { host: env.MYSQL_HOST, database: env.MYSQL_DATABASE });
  return holder.pool;
}

/** The active transaction connection for the current async call chain. */
const activeConn = new AsyncLocalStorage<PoolConnection>();

/** MySQL transient errors: 1213 = deadlock, 1205 = lock wait timeout. */
function isDeadlockError(err: unknown): boolean {
  const n = (err as { errno?: number })?.errno;
  return n === 1213 || n === 1205;
}

/** MySQL "already exists" codes: 1050 table, 1060 column, 1061 index, 1826 FK. */
function isAlreadyExistsError(err: unknown): boolean {
  const n = (err as { errno?: number })?.errno;
  return n === 1050 || n === 1060 || n === 1061 || n === 1826 || n === 1022;
}

/** MySQL unique violations: 1062 duplicate entry, 1169 duplicate on unique index. */
function isUniqueViolationError(err: unknown): boolean {
  const n = (err as { errno?: number })?.errno;
  return n === 1062 || n === 1169;
}

/** Coerce an abstract-typed value to what mysql2 expects on the wire. */
function coerce(p: BoundParam): unknown {
  if (p.value === undefined || p.value === null) return null;
  if (p.type.kind === "bit") return p.value === true || p.value === 1 ? 1 : 0;
  return p.value;
}

export const mysqlDriver: SqlDriver = {
  client: "mysql",
  get poolMax() {
    return env.MYSQL_POOL_MAX;
  },

  async query(text: string, params: BoundParam[]): Promise<QueryResult> {
    const conn = activeConn.getStore();
    const runner = conn ?? getPool();
    const [result] = await runner.query(text, params.map(coerce));
    if (Array.isArray(result)) {
      return { rows: result as Array<Record<string, unknown>>, rowsAffected: 0 };
    }
    const header = result as ResultSetHeader;
    return { rows: [], rowsAffected: header.affectedRows ?? 0, insertId: header.insertId };
  },

  async exec(text: string): Promise<void> {
    await getPool().query(text);
  },

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (activeConn.getStore()) return fn(); // already in a transaction — join it
    for (let attempt = 0; ; attempt++) {
      const conn = await getPool().getConnection();
      try {
        await conn.beginTransaction();
        const result = await activeConn.run(conn, fn);
        await conn.commit();
        return result;
      } catch (err) {
        await conn.rollback().catch(() => {});
        if (isDeadlockError(err) && attempt < MAX_DEADLOCK_RETRIES) {
          metrics.increment("db.deadlockRetry");
          await delay(retryBackoff(attempt));
          continue;
        }
        throw err;
      } finally {
        conn.release();
      }
    }
  },

  async ensureDatabase(): Promise<void> {
    const dbName = env.MYSQL_DATABASE;
    if (!/^[A-Za-z0-9_][A-Za-z0-9_$]*$/.test(dbName)) {
      throw new Error(`Unsafe MYSQL_DATABASE name: "${dbName}"`);
    }
    // Connect without a database to create it (best-effort — a least-privilege
    // user may lack CREATE; that's fine when the schema pre-exists).
    let admin: Connection | null = null;
    try {
      admin = await mysql.createConnection(baseOptions());
      await admin.query(
        `CREATE DATABASE IF NOT EXISTS \`${dbName.replace(/`/g, "``")}\` ` +
          `CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
      logger.info("ensured database exists", { database: dbName });
    } catch (e) {
      logger.warn("skipping database auto-create (no CREATE privilege?); assuming it exists", {
        database: dbName,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (admin) await admin.end().catch(() => {});
    }
  },

  async close(): Promise<void> {
    if (holder.pool) {
      await holder.pool.end();
      holder.pool = null;
    }
  },

  isDeadlock: isDeadlockError,
  isAlreadyExists: isAlreadyExistsError,
  isUniqueViolation: isUniqueViolationError,
  inTransaction: () => activeConn.getStore() !== undefined,
};
