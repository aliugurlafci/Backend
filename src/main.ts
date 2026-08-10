/**
 * Server entrypoint.
 *
 * Boot sequence: validate env → install auth → connect the SQL database (+
 * migrate + seed) → register platform subscribers + reindex → listen. Handles
 * graceful shutdown.
 */
import { env } from "@/lib/config/env";
import { logger } from "@/lib/observability/logger";
import { configureAuth } from "@/lib/security/auth-config";
import { getQueryEngine } from "@/lib/data/store";
import { closePool } from "@/lib/data/sql/connection";
import { bootstrapPlatform } from "@/lib/bootstrap";
import { startScheduler } from "@/lib/jobs/scheduler";
import { releaseLease } from "@/lib/jobs/lease";
import { createApp } from "@/http/server";
import { getInflight } from "@/lib/http/resilience";
import { attachRealtime, closeRealtime } from "@/lib/realtime/server";

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
      tenant: env.AULA_TENANT_ID,
    });
  });

  // Realtime notice channel on the same server (one port, one TLS termination).
  attachRealtime(server);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal, inflight: getInflight() });
    // Close realtime sockets FIRST. `server.close()` waits for open connections
    // to end, and a WebSocket never ends on its own — leaving them open means
    // the close callback below never fires and shutdown falls through to the
    // 10s force-exit on every deploy.
    void closeRealtime();
    // Stop accepting new connections, then let in-flight requests finish before
    // we tear down the pool — so a request mid-transaction isn't orphaned.
    // `server.close` expects a void callback, so the async work is wrapped
    // explicitly: an async callback here would return a promise nobody holds,
    // and a rejection during drain would surface as an unhandled rejection
    // rather than an exit.
    server.close(() => {
      void (async () => {
        const start = Date.now();
        while (getInflight() > 0 && Date.now() - start < 8_000) await delay(100);
        // Awaited, and BEFORE the pool closes. Fire-and-forget here lost the
        // race with `process.exit` — the release had not finished, so it
        // reopened a pool against a closing process and the next instance had
        // to wait out the full lease instead of taking over at once.
        await releaseLease().catch(() => {});
        await closePool().catch(() => {});
        process.exit(0);
      })();
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
