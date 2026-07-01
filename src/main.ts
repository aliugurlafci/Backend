/**
 * Server entrypoint.
 *
 * Boot sequence: validate env → install auth → connect MSSQL (+ migrate + seed)
 * → register platform subscribers + reindex → listen. Handles graceful shutdown.
 */
import { env } from "@/lib/config/env";
import { logger } from "@/lib/observability/logger";
import { configureAuth } from "@/lib/security/auth-config";
import { getQueryEngine } from "@/lib/data/store";
import { closePool } from "@/lib/data/mssql/connection";
import { bootstrapPlatform } from "@/lib/bootstrap";
import { startScheduler } from "@/lib/jobs/scheduler";
import { createApp } from "@/http/server";
import { getInflight } from "@/lib/http/resilience";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  configureAuth();

  // Connect the pool, ensure schema, and seed (driven by AULA_AUTO_* env flags).
  await getQueryEngine();
  // Register event subscribers + rebuild the search index from the repository.
  await bootstrapPlatform();
  // Start the in-process scheduler (recurring jobs + schedule-triggered automations).
  startScheduler();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info("aula-crm backend listening", {
      port: env.PORT,
      env: env.NODE_ENV,
      devAuth: env.AULA_DEV_AUTH,
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal, inflight: getInflight() });
    // Stop accepting new connections, then let in-flight requests finish before
    // we tear down the pool — so a request mid-transaction isn't orphaned.
    server.close(async () => {
      const start = Date.now();
      while (getInflight() > 0 && Date.now() - start < 8_000) await delay(100);
      await closePool().catch(() => {});
      process.exit(0);
    });
    // Hard cap: force-exit if graceful drain doesn't complete in time.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error("fatal startup error", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
