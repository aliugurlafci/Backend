/**
 * Data store wiring (MSSQL).
 *
 * Builds the repository + query engine once per process (pinned to `globalThis`
 * so tsx watch reloads don't duplicate them). On first access it connects the
 * pool and provisions the schema once (when AULA_AUTO_MIGRATE). The ONLY data
 * seeded on boot is the admin user (`ensureAdminSeed`); demo business data + the
 * other users are opt-in via `npm run seed`.
 */
import { env, usingInMemoryBackends } from "@/lib/config/env";
import { metadata } from "@/lib/metadata";
import { permissionEngine } from "@/lib/permissions/engine";
import { QueryEngine } from "./query-engine";
import { InMemoryRepository } from "./memory-repository";
import { SqlRepository } from "./sql/repository";
import { getDriver } from "./sql/driver";
import { runMigrations } from "./sql/migrate";
import { ensureAdminSeed } from "@/lib/security/auth-seed";

type StoreRepository = SqlRepository | InMemoryRepository;

interface Singletons {
  repo: StoreRepository;
  queryEngine: QueryEngine;
  ready: Promise<void> | null;
}

const globalRef = globalThis as unknown as { __aulaStore?: Singletons };

function create(): Singletons {
  const repo: StoreRepository = usingInMemoryBackends
    ? new InMemoryRepository()
    : new SqlRepository(metadata);
  const queryEngine = new QueryEngine(repo, metadata, permissionEngine);
  return { repo, queryEngine, ready: null };
}

const singletons: Singletons = (globalRef.__aulaStore ??= create());

async function init(): Promise<void> {
  // In-memory mode: nothing to migrate. Seed only the admin user.
  if (usingInMemoryBackends) {
    await ensureAdminSeed(singletons.repo);
    return;
  }

  if (env.AULA_AUTO_MIGRATE) {
    await runMigrations(); // first boot: provision the whole schema once (then never again)
  } else {
    await getDriver(); // assume the database + schema already exist (pool connects on first query)
  }
  // The only data seeded on boot is the admin login user (idempotent). Demo data
  // is opt-in: `npm run seed`.
  await ensureAdminSeed(singletons.repo);
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
