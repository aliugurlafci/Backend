/**
 * Schema migration runner — runs ONCE.
 *
 * On first boot it provisions the whole physical schema (support tables + one
 * table per entity, all indexes) in a single pass, then records the schema
 * version in the `_schema_migrations` ledger. Every later boot reads the ledger
 * and skips the DDL entirely, so migrations never run again. To re-provision
 * after a schema change, bump `SCHEMA_VERSION` (it then runs once more).
 *
 * Provisioning runs entity-parallel (each entity's own statements stay ordered:
 * CREATE TABLE → ADD columns → CREATE INDEX; different entities are independent).
 * On a remote/cloud SQL (e.g. Azure SQL) every DDL is a slow round-trip, so a
 * fully-sequential first boot of ~50 entities took minutes — long enough to look
 * hung. Bounded concurrency + progress logs cut that to well under a minute and
 * make the work visible.
 */
import { metadata } from "@/lib/metadata";
import { env } from "@/lib/config/env";
import { systemClock } from "@/lib/core/clock";
import { logger } from "@/lib/observability/logger";
import { ensureDatabase, getPool } from "./connection";
import { entityStatements, allForeignKeyStatements, supportStatements } from "./ddl";

// Bump this whenever the schema changes (new entity/field). On the next boot the
// consolidated DDL is applied exactly once for the new version, then never again.
// v3: currency columns are DECIMAL(18,2) (fresh DBs) + foreign-key constraints
// are provisioned (idempotently added to existing tables on this re-run).
const SCHEMA_VERSION = 3;

/** Run `fn` over `items` with at most `concurrency` in flight (preserves the
 *  pool: never exceeds the connection-pool size). Rejects on the first error. */
async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  };
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
}

/** Concurrency for provisioning: stay a lane below the pool max so a stray query
 *  (seed/health) isn't starved, and never below 2. */
function ddlConcurrency(): number {
  return Math.max(2, (env.MSSQL_POOL_MAX || 8) - 1);
}

export async function runMigrations(): Promise<void> {
  // Create the target database first if it doesn't exist yet.
  await ensureDatabase();
  const pool = await getPool();

  // Ensure the support tables (incl. the `_schema_migrations` ledger) exist so we
  // can tell whether the schema has already been provisioned. Cheap + idempotent.
  for (const stmt of supportStatements()) {
    await pool.request().batch(stmt);
  }

  // Run-once gate: if this schema version is already recorded, do nothing.
  const applied = await pool
    .request()
    .input("v", SCHEMA_VERSION)
    .query(`SELECT 1 AS ok FROM [dbo].[_schema_migrations] WHERE [version] = @v`);
  if (applied.recordset.length > 0) {
    logger.info("schema already provisioned — migration skipped", { version: SCHEMA_VERSION });
    return;
  }

  // First boot: provision every table + index. Entities run in parallel (bounded
  // by the pool); each entity's own statements stay sequential so its table
  // exists before its ALTERs/indexes. On a cloud SQL this turns a minutes-long
  // serial pass into well under a minute.
  const entities = metadata.listEntities();
  const concurrency = ddlConcurrency();
  logger.info("provisioning schema (first boot)", {
    version: SCHEMA_VERSION,
    entities: entities.length,
    concurrency,
  });
  let stmtCount = 0;
  let doneEntities = 0;
  await mapPool(entities, concurrency, async (entity) => {
    for (const stmt of entityStatements(entity)) {
      try {
        await pool.request().batch(stmt);
        stmtCount++;
      } catch (e) {
        logger.error("migration statement failed", { error: String(e), entity: entity.name, stmt });
        throw e;
      }
    }
    doneEntities++;
    if (doneEntities % 10 === 0 || doneEntities === entities.length) {
      logger.info("provisioning progress", { entities: `${doneEntities}/${entities.length}` });
    }
  });

  // Foreign keys run AFTER every table exists, in a TOLERANT pass: a single FK
  // failure is logged but never blocks provisioning (degrades to the prior
  // no-FK behaviour rather than a failed boot). Also bounded-parallel.
  let fkOk = 0;
  const fkStatements = allForeignKeyStatements(entities);
  await mapPool(fkStatements, concurrency, async (stmt) => {
    try {
      await pool.request().batch(stmt);
      fkOk++;
    } catch (e) {
      logger.warn("foreign-key statement skipped", { error: String(e), stmt });
    }
  });
  logger.info("foreign keys provisioned", { ok: fkOk, total: fkStatements.length });

  // Record the version so this never runs again.
  await pool
    .request()
    .input("v", SCHEMA_VERSION)
    .input("at", systemClock.isoNow())
    .query(
      `IF NOT EXISTS (SELECT 1 FROM [dbo].[_schema_migrations] WHERE [version] = @v) ` +
        `INSERT INTO [dbo].[_schema_migrations] ([version], [appliedAt]) VALUES (@v, @at);`,
    );

  logger.info("schema migration complete (provisioned once)", {
    version: SCHEMA_VERSION,
    entities: entities.length,
    statements: stmtCount,
    foreignKeys: fkOk,
  });
}
