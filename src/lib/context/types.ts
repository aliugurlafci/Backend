/**
 * Phase 4 — Multi-tenant request context contract.
 *
 * Every operation in the platform is performed *as* a context. It carries the
 * tenant/org scope used for isolation, the authenticated principal and its
 * roles (for permissions), locale, resolved feature flags and a correlation id
 * for tracing.
 */

export interface Principal {
  userId: string;
  displayName: string;
  email: string;
  roles: string[];
  /** The user's position (drives screen access); absent for dev personas. */
  positionId?: string;
}

export interface RequestContext {
  readonly tenantId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly roles: readonly string[];
  /** The caller's position id (screen access); absent for dev/system actors. */
  readonly positionId?: string;
  readonly locale: string;
  readonly featureFlags: Readonly<Record<string, boolean>>;
  readonly correlationId: string;
  /** Request timestamp (ISO), single source of truth for audit records. */
  readonly at: string;
  /** True for internal/system actors (workflows, migrations) that bypass auth. */
  readonly isSystem: boolean;
}

/** Tenant scope extracted from a context — the unit of data isolation. */
export interface TenantScope {
  tenantId: string;
  orgId: string;
}
