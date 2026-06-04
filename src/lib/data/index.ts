/** Phase 5 — Query engine & data layer barrel. */
export * from "./query";
export type { Repository } from "./repository";
export { QueryEngine } from "./query-engine";
export type { UpdateOptions } from "./query-engine";
export { InMemoryRepository } from "./memory-repository";
export { MssqlRepository } from "./mssql/mssql-repository";
export { getQueryEngine, getRepository } from "./store";
export { seedInto, isSeeded } from "./seed";
export { runMigrations } from "./mssql/migrate";
export { getPool, closePool } from "./mssql/connection";
