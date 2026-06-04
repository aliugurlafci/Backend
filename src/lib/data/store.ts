/**
 * Data store wiring (MSSQL).
 *
 * Builds the repository + query engine once per process (pinned to `globalThis`
 * so tsx watch reloads don't duplicate them). On first access it connects the
 * pool, ensures the schema (when AULA_AUTO_MIGRATE) and seeds demo data once
 * (when AULA_AUTO_SEED and the database is empty).
 */
import { env, usingInMemoryBackends } from "@/lib/config/env";
import { logger } from "@/lib/observability/logger";
import { metadata } from "@/lib/metadata";
import { permissionEngine } from "@/lib/permissions/engine";
import { QueryEngine } from "./query-engine";
import { InMemoryRepository } from "./memory-repository";
import { MssqlRepository } from "./mssql/mssql-repository";
import { getPool } from "./mssql/connection";
import { runMigrations } from "./mssql/migrate";
import { isSeeded, seedInto } from "./seed";
import { ensureAuthSeed } from "@/lib/security/auth-seed";

type StoreRepository = MssqlRepository | InMemoryRepository;

interface Singletons {
  repo: StoreRepository;
  queryEngine: QueryEngine;
  ready: Promise<void> | null;
}

const globalRef = globalThis as unknown as { __aulaStore?: Singletons };

function create(): Singletons {
  const repo: StoreRepository = usingInMemoryBackends
    ? new InMemoryRepository()
    : new MssqlRepository(metadata);
  const queryEngine = new QueryEngine(repo, metadata, permissionEngine);
  return { repo, queryEngine, ready: null };
}

const singletons: Singletons = (globalRef.__aulaStore ??= create());

async function init(): Promise<void> {
  // In-memory mode: no DB to migrate; seed once into the process-local store.
  if (usingInMemoryBackends) {
    if (env.AULA_AUTO_SEED) {
      await seedInto(singletons.repo);
      logger.info("seed complete (in-memory persistence)");
    }
    await ensureAuthSeed(singletons.repo); // login users + positions (idempotent)
    return;
  }

  if (env.AULA_AUTO_MIGRATE) {
    await runMigrations(); // ensures the database exists, then provisions the schema
  } else {
    await getPool(); // assume the database + schema already exist
  }
  if (env.AULA_AUTO_SEED) {
    if (await isSeeded()) {
      logger.info("seed skipped — database already populated");
    } else {
      await seedInto(singletons.repo);
      logger.info("seed complete");
    }
  }
  await ensureAuthSeed(singletons.repo); // login users + positions (idempotent)
}

/** Resolve the query engine, ensuring the store is connected, migrated & seeded. */
export async function getQueryEngine(): Promise<QueryEngine> {
  singletons.ready ??= init();
  await singletons.ready;
  return singletons.queryEngine;
}

/** The repository singleton (used by the search reindexer). */
export function getRepository(): StoreRepository {
  return singletons.repo;
}
