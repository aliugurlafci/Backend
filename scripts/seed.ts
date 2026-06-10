/**
 * CLI: provision the schema, then seed the OPT-IN demo dataset (admin + demo
 * users + demo business data). Idempotent — skips the business data if already
 * seeded. The server itself only seeds the admin user on boot; run this when you
 * want the full demo populated.
 *   npm run seed
 */
import { closePool } from "@/lib/data/mssql/connection";
import { runMigrations } from "@/lib/data/mssql/migrate";
import { getRepository } from "@/lib/data/store";
import { isSeeded, seedInto } from "@/lib/data/seed";
import { ensureAdminSeed, ensureDemoUsers } from "@/lib/security/auth-seed";
import { logger } from "@/lib/observability/logger";

async function main(): Promise<void> {
  await runMigrations(); // ensures the database exists + provisions the schema (once)
  await ensureAdminSeed(getRepository()); // admin login user (also seeded on boot)
  if (await isSeeded()) {
    logger.info("seed skipped — database already populated");
  } else {
    await ensureDemoUsers(getRepository()); // manager / rep / accountant
    await seedInto(getRepository()); // demo business data (accounts, products, …)
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
