/**
 * CLI: provision the database schema and ensure the administrator account
 * exists. Idempotent — safe to re-run; it never touches existing data.
 *
 * The server does the same on boot, so this is only needed to prepare a
 * database ahead of time (CI, a fresh install, AULA_AUTO_MIGRATE=false).
 *   npm run seed
 */
import { closePool } from "@/lib/data/sql/connection";
import { runMigrations } from "@/lib/data/sql/migrate";
import { getRepository } from "@/lib/data/store";
import { ensureAdminSeed, ADMIN_EMAIL } from "@/lib/security/auth-seed";
import { logger } from "@/lib/observability/logger";

async function main(): Promise<void> {
  await runMigrations(); // ensures the database exists + provisions the schema (once)
  await ensureAdminSeed(getRepository());
  logger.info("provisioning complete", { admin: ADMIN_EMAIL });
  await closePool();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("provisioning failed", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
