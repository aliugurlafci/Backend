/**
 * Phase 4 — Context resolver (auth + locale + feature flags).
 *
 * Builds an immutable RequestContext from request headers. Authentication is
 * pluggable: the default dev authenticator maps an `x-actor` header to a demo
 * principal, and Phase 13 swaps in a JWT/OIDC authenticator via
 * `setAuthenticator` without the rest of the stack changing.
 */
import { systemClock } from "@/lib/core/clock";
import { newCorrelationId } from "@/lib/core/ids";
import { UnauthenticatedError } from "@/lib/enforcement/errors";
import { configStore } from "./config";
import { DEMO_ORG, DEMO_TENANT, DEMO_USERS, OTHER_ORG, OTHER_TENANT, OTHER_USER } from "./dev";
import type { Principal, RequestContext, TenantScope } from "./types";

export type AuthenticatedPrincipal = Principal & TenantScope;

export type Authenticator = (headers: Headers) => AuthenticatedPrincipal | null;

function readCookie(headers: Headers, name: string): string | null {
  const cookie = headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/**
 * Dev authenticator: pick a seeded principal via header or `aula_actor` cookie.
 * Returns null when no actor is supplied (no silent default), so the real login
 * gate can treat such requests as unauthenticated.
 */
export const devAuthenticator: Authenticator = (headers) => {
  // Allow tests to target the other tenant.
  if (headers.get("x-tenant") === OTHER_TENANT) {
    return { ...OTHER_USER, tenantId: OTHER_TENANT, orgId: OTHER_ORG };
  }
  const actor = headers.get("x-actor") ?? readCookie(headers, "aula_actor");
  if (!actor) return null;
  const principal = DEMO_USERS[actor] ?? DEMO_USERS.admin;
  return { ...principal, tenantId: DEMO_TENANT, orgId: DEMO_ORG };
};

let authenticator: Authenticator = devAuthenticator;

export function setAuthenticator(fn: Authenticator): void {
  authenticator = fn;
}

function pickLocale(headers: Headers): string {
  const explicit = headers.get("x-locale");
  if (explicit) return explicit;
  const accept = headers.get("accept-language");
  if (accept) return accept.split(",")[0].trim().split("-")[0] || "en";
  return "en";
}

/** Resolve a context, throwing if authentication fails. */
export function resolveContext(headers: Headers): RequestContext {
  const principal = authenticator(headers);
  if (!principal) throw new UnauthenticatedError();

  const scopeKeys = {
    tenantId: principal.tenantId,
    orgId: principal.orgId,
    userId: principal.userId,
  };

  return Object.freeze({
    tenantId: principal.tenantId,
    orgId: principal.orgId,
    userId: principal.userId,
    displayName: principal.displayName,
    email: principal.email,
    roles: Object.freeze([...principal.roles]),
    positionId: principal.positionId,
    locale: pickLocale(headers),
    featureFlags: Object.freeze(configStore.featureFlags(scopeKeys)),
    correlationId: headers.get("x-correlation-id") ?? newCorrelationId(),
    at: systemClock.isoNow(),
    isSystem: false,
  });
}

/** A privileged system context for workflows, seeds and migrations. */
export function systemContext(
  tenantId: string,
  orgId: string,
  overrides: Partial<RequestContext> = {},
): RequestContext {
  return Object.freeze({
    tenantId,
    orgId,
    userId: "system",
    displayName: "System",
    email: "system@aula.crm",
    roles: Object.freeze(["system"]),
    locale: "en",
    featureFlags: Object.freeze(configStore.featureFlags({ tenantId, orgId, userId: "system" })),
    correlationId: newCorrelationId(),
    at: systemClock.isoNow(),
    isSystem: true,
    ...overrides,
  });
}
