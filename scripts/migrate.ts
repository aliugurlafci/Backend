/**
 * CLI: provision/refresh the database schema from metadata.
 *   npm run migrate
 */
import { runMigrations } from "@/lib/data/mssql/migrate";
import { closePool } from "@/lib/data/mssql/connection";
import { logger } from "@/lib/observability/logger";

async function main(): Promise<void> {
  await runMigrations();
  await closePool();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("migrate failed", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
