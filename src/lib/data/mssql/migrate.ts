/**
 * Schema migration runner — runs ONCE.
 *
 * On first boot it provisions the whole physical schema (support tables + one
 * table per entity, all indexes) in a single pass, then records the schema
 * version in the `_schema_migrations` ledger. Every later boot reads the ledger
 * and skips the DDL entirely, so migrations never run again. To re-provision
 * after a schema change, bump `SCHEMA_VERSION` (it then runs once more).
 */
import { metadata } from "@/lib/metadata";
import { systemClock } from "@/lib/core/clock";
import { logger } from "@/lib/observability/logger";
import { ensureDatabase, getPool } from "./connection";
import { allStatements, supportStatements } from "./ddl";

// Bump this whenever the schema changes (new entity/field). On the next boot the
// consolidated DDL is applied exactly once for the new version, then never again.
// Set to 2 so existing databases (which recorded v1 under the old always-run
// migrate) re-provision the current full schema one final time.
const SCHEMA_VERSION = 2;

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

  // First boot: provision every table + index in one pass.
  const statements = allStatements(metadata.listEntities());
  for (const stmt of statements) {
    try {
      await pool.request().batch(stmt);
    } catch (e) {
      logger.error("migration statement failed", { error: String(e), stmt });
      throw e;
    }
  }

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
    entities: metadata.listEntities().length,
    statements: statements.length,
  });
}
