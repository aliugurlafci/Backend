/**
 * SQL Server driver (node-mssql).
 *
 * A single process-wide connection pool pinned to `globalThis` so dev reloads
 * (tsx watch) don't leak pools. Binds `@pN` parameters by name, routes queries
 * to the active transaction (via AsyncLocalStorage) when one is open, and
 * retries deadlock victims.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import sql from "mssql";
import { env } from "@/lib/config/env";
import { logger } from "@/lib/observability/logger";
import { metrics } from "@/lib/observability/metrics";
import type { SqlDriver, } from "./driver";
import { MAX_DEADLOCK_RETRIES, delay, retryBackoff } from "./driver";
import type { BoundParam, QueryResult, SqlType } from "./types";

function buildConfig(): sql.config {
  const useInstance = Boolean(env.MSSQL_INSTANCE);
  return {
    server: env.MSSQL_SERVER,
    // A named instance is resolved by SQL Browser; a static port is not used.
    port: useInstance ? undefined : env.MSSQL_PORT,
    database: env.MSSQL_DATABASE,
    user: env.MSSQL_USER,
    password: env.MSSQL_PASSWORD,
    // node-mssql defaults requestTimeout to 15s — far too tight for bulk work.
    requestTimeout: 120_000,
    connectionTimeout: 30_000,
    options: {
      encrypt: env.MSSQL_ENCRYPT,
      trustServerCertificate: env.MSSQL_TRUST_SERVER_CERTIFICATE,
      instanceName: env.MSSQL_INSTANCE || undefined,
      enableArithAbort: true,
      appName: "aula-crm-backend",
    },
    pool: {
      max: env.MSSQL_POOL_MAX,
      min: env.MSSQL_POOL_MIN,
      idleTimeoutMillis: 30_000,
    },
  };
}

interface PoolHolder {
  pool: sql.ConnectionPool | null;
  connecting: Promise<sql.ConnectionPool> | null;
}

const globalRef = globalThis as unknown as { __aulaMssqlPool?: PoolHolder };
const holder: PoolHolder = (globalRef.__aulaMssqlPool ??= { pool: null, connecting: null });

/** Resolve the shared, connected pool (connecting on first use). */
async function getPool(): Promise<sql.ConnectionPool> {
  if (holder.pool?.connected) return holder.pool;
  if (holder.connecting) return holder.connecting;
  holder.connecting = (async () => {
    const pool = new sql.ConnectionPool(buildConfig());
    pool.on("error", (e) => logger.error("mssql pool error", { error: String(e) }));
    await pool.connect();
    holder.pool = pool;
    holder.connecting = null;
    logger.info("mssql connected", { server: env.MSSQL_SERVER, database: env.MSSQL_DATABASE });
    return pool;
  })();
  return holder.connecting;
}

/** The active SQL transaction for the current async call chain. */
const activeTx = new AsyncLocalStorage<sql.Transaction>();

/** Map an abstract parameter type to a node-mssql binding type. */
function toMssqlType(type: SqlType): sql.ISqlType {
  switch (type.kind) {
    case "int":
      return sql.Int();
    case "bigint":
      return sql.BigInt();
    case "float":
      return sql.Float();
    case "decimal":
      return sql.Decimal(type.precision, type.scale);
    case "bit":
      return sql.Bit();
    case "text":
      return sql.NVarChar(sql.MAX);
    case "binary":
      return sql.VarBinary(sql.MAX);
    case "string":
    default:
      return sql.NVarChar(type.kind === "string" ? type.length : 4000);
  }
}

async function request(): Promise<sql.Request> {
  const tx = activeTx.getStore();
  if (tx) return new sql.Request(tx); // bound to the open transaction
  return (await getPool()).request();
}

function isTransientLockError(err: unknown): boolean {
  const n = (err as { number?: number })?.number;
  return n === 1205 || n === 1222; // 1205 = deadlock victim, 1222 = lock timeout
}

/** SQL Server "already exists" codes: 2714 object, 1913 index, 2705 column. */
function isAlreadyExistsError(err: unknown): boolean {
  const n = (err as { number?: number })?.number;
  return n === 2714 || n === 1913 || n === 2705;
}

/** SQL Server unique violations: 2627 (PK/unique constraint), 2601 (unique index). */
function isUniqueViolationError(err: unknown): boolean {
  const n = (err as { number?: number })?.number;
  return n === 2627 || n === 2601;
}

export const mssqlDriver: SqlDriver = {
  client: "mssql",
  get poolMax() {
    return env.MSSQL_POOL_MAX;
  },

  async query(text: string, params: BoundParam[]): Promise<QueryResult> {
    const req = await request();
    params.forEach((p, i) => req.input(`p${i}`, toMssqlType(p.type), p.value ?? null));
    const result = await req.query(text);
    return {
      rows: (result.recordset as Array<Record<string, unknown>>) ?? [],
      rowsAffected: result.rowsAffected?.[0] ?? 0,
    };
  },

  async exec(text: string): Promise<void> {
    // DDL / batches never run inside a transaction here, so always use the pool.
    await (await getPool()).request().batch(text);
  },

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (activeTx.getStore()) return fn(); // already in a transaction — join it
    for (let attempt = 0; ; attempt++) {
      const tx = new sql.Transaction(await getPool());
      await tx.begin();
      let committed = false;
      try {
        const result = await activeTx.run(tx, fn);
        await tx.commit();
        committed = true;
        return result;
      } catch (err) {
        if (isTransientLockError(err) && attempt < MAX_DEADLOCK_RETRIES) {
          metrics.increment("db.deadlockRetry");
          await tx.rollback().catch(() => {});
          committed = true; // handled here — skip the finally's rollback
          await delay(retryBackoff(attempt));
          continue;
        }
        throw err;
      } finally {
        if (!committed) await tx.rollback().catch(() => {});
      }
    }
  },

  async ensureDatabase(): Promise<void> {
    const dbName = env.MSSQL_DATABASE;
    // The escape on `-` is redundant only because it sits last in the class.
    // This pattern guards a name that is interpolated into DDL, so it is spelled
    // defensively on purpose and left exactly as written.
    // eslint-disable-next-line no-useless-escape
    if (!/^[A-Za-z0-9_][A-Za-z0-9_ \-]*$/.test(dbName)) {
      throw new Error(`Unsafe MSSQL_DATABASE name: "${dbName}"`);
    }
    const adminConfig: sql.config = {
      ...buildConfig(),
      database: "master",
      pool: { max: 1, min: 0, idleTimeoutMillis: 5_000 },
    };
    let admin: sql.ConnectionPool | null = null;
    try {
      admin = new sql.ConnectionPool(adminConfig);
      await admin.connect();
      const literal = dbName.replace(/'/g, "''");
      const createSql = `CREATE DATABASE [${dbName.replace(/]/g, "]]")}]`.replace(/'/g, "''");
      await admin.request().batch(`IF DB_ID(N'${literal}') IS NULL EXEC('${createSql}');`);
      logger.info("ensured database exists", { database: dbName });
    } catch (e) {
      logger.warn("skipping database auto-create (no master access?); assuming it exists", {
        database: dbName,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (admin) await admin.close().catch(() => {});
    }
  },

  async close(): Promise<void> {
    if (holder.pool) {
      await holder.pool.close();
      holder.pool = null;
    }
    holder.connecting = null;
  },

  isDeadlock: isTransientLockError,
  isAlreadyExists: isAlreadyExistsError,
  isUniqueViolation: isUniqueViolationError,
  inTransaction: () => activeTx.getStore() !== undefined,
};
