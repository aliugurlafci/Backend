/**
 * Phase 14 — Feature flags.
 *
 * Flag defaults seeded into the config hierarchy (Phase 4) so they resolve with
 * tenant/org/user precedence. Toggling a flag for a tenant is a
 * `configStore.setTenant(id, { features: { flag: false } })` call.
 */
import { configStore } from "@/lib/context/config";
import type { RequestContext } from "@/lib/context/types";

export const FEATURE_FLAGS = {
  metadataGovernance: true,
  csvExport: true,
  globalSearch: true,
  betaForecast: false,
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;

let seeded = false;

export function seedFeatureFlags(): void {
  if (seeded) return;
  seeded = true;
  configStore.setSystem({ features: { ...FEATURE_FLAGS } });
}

export function isEnabled(ctx: RequestContext, flag: FeatureFlag): boolean {
  return ctx.featureFlags[flag] ?? FEATURE_FLAGS[flag];
}

// Seed defaults eagerly so contexts resolved before platform boot still see them.
seedFeatureFlags();
