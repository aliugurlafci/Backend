/**
 * MSSQL connection pool.
 *
 * A single process-wide connection pool, pinned to `globalThis` so dev reloads
 * (tsx watch) don't leak pools. All repository/sequence/migration code acquires
 * the pool through `getPool()`.
 */
import sql from "mssql";
import { env } from "@/lib/config/env";
import { logger } from "@/lib/observability/logger";

function buildConfig(): sql.config {
  const useInstance = Boolean(env.MSSQL_INSTANCE);
  return {
    server: env.MSSQL_SERVER,
    // A named instance is resolved by SQL Browser; a static port is not used.
    port: useInstance ? undefined : env.MSSQL_PORT,

    database: env.MSSQL_DATABASE,
    user: env.MSSQL_USER,
    password: env.MSSQL_PASSWORD,
    // node-mssql defaults requestTimeout to 15s — far too tight for bulk work
    // (a single large multi-row INSERT or the uniqueness preload aggregate on a
    // big table can exceed it, throwing mid-import and leaving a partial write).
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

const globalRef = globalThis as unknown as { __aulaMssql?: PoolHolder };
const holder: PoolHolder = (globalRef.__aulaMssql ??= { pool: null, connecting: null });

/** Resolve the shared, connected pool (connecting on first use). */
export async function getPool(): Promise<sql.ConnectionPool> {
  if (holder.pool?.connected) return holder.pool;
  if (holder.connecting) return holder.connecting;

  holder.connecting = (async () => {
    const pool = new sql.ConnectionPool(buildConfig());
    pool.on("error", (e) => logger.error("mssql pool error", { error: String(e) }));
    await pool.connect();
    holder.pool = pool;
    holder.connecting = null;
    logger.info("mssql connected", {
      server: env.MSSQL_SERVER,
      database: env.MSSQL_DATABASE,
    });
    return pool;
  })();

  return holder.connecting;
}

/** Close the pool (used by graceful shutdown and tests). */
export async function closePool(): Promise<void> {
  if (holder.pool) {
    await holder.pool.close();
    holder.pool = null;
  }
  holder.connecting = null;
}

/**
 * Ensure the target database exists, creating it if missing.
 *
 * Connects to `master` (you cannot connect to a database that doesn't exist
 * yet), then `CREATE DATABASE` if absent. The name is validated and escaped, so
 * a hostile `MSSQL_DATABASE` value can't break out of the statement. (On Azure
 * SQL, create the database via the portal/elastic pool instead.)
 */
export async function ensureDatabase(): Promise<void> {
  const dbName = env.MSSQL_DATABASE;
  if (!/^[A-Za-z0-9_][A-Za-z0-9_ \-]*$/.test(dbName)) {
    throw new Error(`Unsafe MSSQL_DATABASE name: "${dbName}"`);
  }

  const adminConfig: sql.config = {
    ...buildConfig(),
    database: "master",
    pool: { max: 1, min: 0, idleTimeoutMillis: 5_000 },
  };

  // Best-effort: a least-privilege login may be scoped to its own database and
  // unable to connect to `master` or `CREATE DATABASE`. That's fine when the
  // database already exists (or a DBA pre-created it) — continue and let the
  // schema provisioning connect directly. If the DB is genuinely missing, the
  // subsequent getPool() surfaces a clear "cannot open database" error.
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
}

export { sql };
