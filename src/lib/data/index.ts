/** Phase 5 — Query engine & data layer barrel. */
export * from "./query";
export type { Repository } from "./repository";
export { QueryEngine } from "./query-engine";
export type { UpdateOptions } from "./query-engine";
export { InMemoryRepository } from "./memory-repository";
export { SqlRepository } from "./sql/repository";
export { getQueryEngine, getRepository } from "./store";
export { seedInto, isSeeded } from "./seed";
export { runMigrations } from "./sql/migrate";
export { closePool } from "./sql/connection";
export { getDriver } from "./sql/driver";
export { getDialect } from "./sql/dialect";
