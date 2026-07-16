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
// Schema provisioning lives entirely in the metadata-driven migrator
// (`@/lib/data/sql/migrate`), which targets SQL Server or MySQL via the dialect.
