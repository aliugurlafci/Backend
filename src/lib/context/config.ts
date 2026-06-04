/**
 * Phase 4 — Config hierarchy.
 *
 * Configuration and feature flags resolve through layered scopes with
 * precedence: system < tenant < org < user. The most specific layer wins.
 * Feature flags are just a reserved `features` config key resolved the same way.
 */
import type { RequestContext } from "./types";

type Scope = "system" | "tenant" | "org" | "user";

interface ConfigLayer {
  scope: Scope;
  /** null for the system layer; otherwise the tenant/org/user id. */
  id: string | null;
  values: Record<string, unknown>;
}

const PRECEDENCE: Record<Scope, number> = { system: 0, tenant: 1, org: 2, user: 3 };

export class ConfigStore {
  private layers: ConfigLayer[] = [];

  setSystem(values: Record<string, unknown>): this {
    return this.upsert("system", null, values);
  }
  setTenant(tenantId: string, values: Record<string, unknown>): this {
    return this.upsert("tenant", tenantId, values);
  }
  setOrg(orgId: string, values: Record<string, unknown>): this {
    return this.upsert("org", orgId, values);
  }
  setUser(userId: string, values: Record<string, unknown>): this {
    return this.upsert("user", userId, values);
  }

  private upsert(scope: Scope, id: string | null, values: Record<string, unknown>): this {
    const existing = this.layers.find((l) => l.scope === scope && l.id === id);
    if (existing) Object.assign(existing.values, values);
    else this.layers.push({ scope, id, values: { ...values } });
    return this;
  }

  private applicable(scopeKeys: { tenantId: string; orgId: string; userId: string }): ConfigLayer[] {
    return this.layers
      .filter((l) => {
        if (l.scope === "system") return true;
        if (l.scope === "tenant") return l.id === scopeKeys.tenantId;
        if (l.scope === "org") return l.id === scopeKeys.orgId;
        return l.id === scopeKeys.userId;
      })
      .sort((a, b) => PRECEDENCE[a.scope] - PRECEDENCE[b.scope]);
  }

  /** Merge all applicable layers for a context into a single config object. */
  resolve(scopeKeys: { tenantId: string; orgId: string; userId: string }): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const layer of this.applicable(scopeKeys)) Object.assign(merged, layer.values);
    return merged;
  }

  get<T>(scopeKeys: { tenantId: string; orgId: string; userId: string }, key: string, fallback: T): T {
    const merged = this.resolve(scopeKeys);
    return (key in merged ? (merged[key] as T) : fallback);
  }

  /** Resolved feature flags, merged across scopes. */
  featureFlags(scopeKeys: { tenantId: string; orgId: string; userId: string }): Record<string, boolean> {
    const flags: Record<string, boolean> = {};
    for (const layer of this.applicable(scopeKeys)) {
      const f = layer.values.features as Record<string, boolean> | undefined;
      if (f) Object.assign(flags, f);
    }
    return flags;
  }
}

/** Convenience overload that accepts a full RequestContext. */
export function flagsFor(store: ConfigStore, ctx: RequestContext): Record<string, boolean> {
  return store.featureFlags(ctx);
}

/** The platform-wide config store (seeded in Phase 14). */
export const configStore = new ConfigStore();
