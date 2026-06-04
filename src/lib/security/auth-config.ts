/**
 * Auth wiring for the backend.
 *
 * Installs the active authenticator based on configuration:
 *  - production / AULA_DEV_AUTH=false → JWT bearer tokens only.
 *  - development / AULA_DEV_AUTH=true → JWT if an Authorization header is present,
 *    otherwise the dev persona authenticator (x-actor / aula_actor cookie).
 *
 * `issuePersonaToken` powers POST /auth/login, minting a real signed JWT for a
 * demo persona so clients can exercise the production bearer-token path.
 */
import { env, jwtSecret } from "@/lib/config/env";
import { devAuthenticator, setAuthenticator } from "@/lib/context/resolver";
import {
  DEMO_ORG,
  DEMO_TENANT,
  DEMO_USERS,
  OTHER_ORG,
  OTHER_TENANT,
  OTHER_USER,
} from "@/lib/context/dev";
import type { Principal } from "@/lib/context/types";
import { jwtAuthenticator, sessionAuthenticator, signJwt } from "./auth";

/**
 * Install the configured authenticator. Order: bearer token → httpOnly session
 * cookie (credential login) → dev persona (only when AULA_DEV_AUTH and an actor
 * is supplied). With no match the request is unauthenticated, enabling the gate.
 */
export function configureAuth(): void {
  const jwt = jwtAuthenticator(jwtSecret);
  const session = sessionAuthenticator(jwtSecret);
  setAuthenticator((headers) => {
    const auth = headers.get("authorization");
    if (auth?.startsWith("Bearer ")) return jwt(headers);
    const fromSession = session(headers);
    if (fromSession) return fromSession;
    if (env.AULA_DEV_AUTH) return devAuthenticator(headers);
    return null;
  });
}

export interface IssuedToken {
  token: string;
  tokenType: "Bearer";
  expiresIn: number;
  user: { userId: string; displayName: string; email: string; roles: string[]; tenantId: string; orgId: string };
}

/** Resolve a persona + tenant scope for a login actor key. */
function personaFor(actor: string): { principal: Principal; tenantId: string; orgId: string } | null {
  if (actor === "globex") {
    return { principal: OTHER_USER, tenantId: OTHER_TENANT, orgId: OTHER_ORG };
  }
  const principal = DEMO_USERS[actor];
  if (!principal) return null;
  return { principal, tenantId: DEMO_TENANT, orgId: DEMO_ORG };
}

/**
 * Mint a signed JWT for a demo persona. In a real deployment this is where you
 * would validate credentials against your identity provider before signing.
 */
export function issuePersonaToken(actor: string): IssuedToken | null {
  const resolved = personaFor(actor);
  if (!resolved) return null;
  const { principal, tenantId, orgId } = resolved;
  const token = signJwt(
    {
      sub: principal.userId,
      name: principal.displayName,
      email: principal.email,
      roles: principal.roles,
      tenantId,
      orgId,
    },
    jwtSecret,
    env.AULA_JWT_TTL,
  );
  return {
    token,
    tokenType: "Bearer",
    expiresIn: env.AULA_JWT_TTL,
    user: {
      userId: principal.userId,
      displayName: principal.displayName,
      email: principal.email,
      roles: [...principal.roles],
      tenantId,
      orgId,
    },
  };
}

/** Available login persona keys (for the login UI / docs). */
export const LOGIN_ACTORS = ["admin", "manager", "rep", "accountant", "globex"] as const;
