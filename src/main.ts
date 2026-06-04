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
import { createApp } from "@/http/server";
import { attachChatWs } from "@/lib/realtime/chat-ws";

async function main(): Promise<void> {
  configureAuth();

  // Connect the pool, ensure schema, and seed (driven by AULA_AUTO_* env flags).
  await getQueryEngine();
  // Register event subscribers + rebuild the search index from the repository.
  await bootstrapPlatform();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info("aula-crm backend listening", {
      port: env.PORT,
      env: env.NODE_ENV,
      devAuth: env.AULA_DEV_AUTH,
    });
  });

  // Real-time chat: WebSocket server on the same HTTP server (/ws/chat).
  attachChatWs(server);

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    server.close(() => {
      void closePool().finally(() => process.exit(0));
    });
    // Force-exit if connections don't drain in time.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error("fatal startup error", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
