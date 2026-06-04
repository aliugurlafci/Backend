/** Phase 14 — Release & governance barrel. */
export { env, isProduction, usingInMemoryBackends } from "./env";
export type { Env } from "./env";
export {
  FEATURE_FLAGS,
  seedFeatureFlags,
  isEnabled,
} from "./feature-flags";
export type { FeatureFlag } from "./feature-flags";
export { publishMetadata, rollbackMetadata } from "./governance";
export { releaseLog, ReleaseLog } from "./release";
export type { ReleaseRecord, ReleaseKind } from "./release";
export { MIGRATIONS, MigrationRunner, migrationRunner } from "./migrations";
export type { Migration } from "./migrations";
