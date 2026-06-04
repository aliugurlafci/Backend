/**
 * Schema migration runner.
 *
 * Provisions the full physical schema (support tables + one table per entity)
 * from metadata, idempotently. Safe to run repeatedly — every statement guards
 * itself with IF NOT EXISTS — so it doubles as an "ensure schema" on boot.
 */
import { metadata } from "@/lib/metadata";
import { systemClock } from "@/lib/core/clock";
import { logger } from "@/lib/observability/logger";
import { ensureDatabase, getPool } from "./connection";
import { allStatements } from "./ddl";

const SCHEMA_VERSION = 1;

export async function runMigrations(): Promise<void> {
  // Create the target database first if it doesn't exist yet.
  await ensureDatabase();
  const pool = await getPool();
  const statements = allStatements(metadata.listEntities());

  for (const stmt of statements) {
    try {
      await pool.request().batch(stmt);
    } catch (e) {
      logger.error("migration statement failed", { error: String(e), stmt });
      throw e;
    }
  }

  await pool
    .request()
    .input("v", SCHEMA_VERSION)
    .input("at", systemClock.isoNow())
    .query(
      `IF NOT EXISTS (SELECT 1 FROM [dbo].[_schema_migrations] WHERE [version] = @v) ` +
        `INSERT INTO [dbo].[_schema_migrations] ([version], [appliedAt]) VALUES (@v, @at);`,
    );

  logger.info("schema migration complete", {
    entities: metadata.listEntities().length,
    statements: statements.length,
  });
}
