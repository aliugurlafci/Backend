/**
 * Phase 4 — Context resolver (auth + locale + feature flags).
 *
 * Builds an immutable RequestContext from request headers. Authentication is
 * pluggable: `configureAuth` (lib/security/auth-config) installs the real
 * bearer-token + session-cookie authenticator at boot. Until then nothing
 * authenticates — there is no built-in principal to fall back to.
 */
import { systemClock } from "@/lib/core/clock";
import { newCorrelationId } from "@/lib/core/ids";
import { UnauthenticatedError } from "@/lib/enforcement/errors";
import { configStore } from "./config";
import type { Principal, RequestContext, TenantScope } from "./types";

export type AuthenticatedPrincipal = Principal & TenantScope;

export type Authenticator = (headers: Headers) => AuthenticatedPrincipal | null;

/** No principal until `configureAuth` installs the real authenticator. */
let authenticator: Authenticator = () => null;

export function setAuthenticator(fn: Authenticator): void {
  authenticator = fn;
}

function pickLocale(headers: Headers): string {
  const explicit = headers.get("x-locale");
  if (explicit) return explicit;
  const accept = headers.get("accept-language");
  // "tr-TR,tr;q=0.9" -> "tr". Any part failing to parse falls back to English
  // rather than to an empty locale, which no message catalogue answers to.
  if (accept) return accept.split(",")[0]?.trim().split("-")[0] || "en";
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
    grants: principal.grants ? Object.freeze([...principal.grants]) : undefined,
    // Carried through so `assertTokenActive` can check revocation without
    // re-parsing the token it came from.
    jti: principal.jti,
    tokenEpoch: principal.tokenEpoch,
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
