/**
 * CLI: ensure schema, then seed demo data (idempotent — skips if already seeded).
 *   npm run seed
 */
import { closePool } from "@/lib/data/mssql/connection";
import { runMigrations } from "@/lib/data/mssql/migrate";
import { getRepository } from "@/lib/data/store";
import { isSeeded, seedInto } from "@/lib/data/seed";
import { logger } from "@/lib/observability/logger";

async function main(): Promise<void> {
  await runMigrations(); // ensures the database exists + provisions the schema
  if (await isSeeded()) {
    logger.info("seed skipped — database already populated");
  } else {
    await seedInto(getRepository());
    logger.info("seed complete");
  }
  await closePool();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("seed failed", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
