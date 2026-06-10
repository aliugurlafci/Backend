/**
 * Phase 13 — Auth integration (JWT/OIDC-ready).
 *
 * HS256 JWT signing/verification with no external dependency. `jwtAuthenticator`
 * plugs into the Phase 4 context resolver, so enabling real auth is a one-liner
 * (`enableJwtAuth(secret)`); an OIDC provider would supply the same claims.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { UnauthenticatedError } from "@/lib/enforcement/errors";
import { setAuthenticator, type Authenticator } from "@/lib/context/resolver";

export interface JwtClaims {
  sub: string;
  name?: string;
  email?: string;
  roles?: string[];
  tenantId?: string;
  orgId?: string;
  /** The user's position id (screen access). */
  positionId?: string;
  /** Explicit operation grants from the position's permission matrix (authoritative when present). */
  grants?: string[];
  exp?: number;
  iat?: number;
  iss?: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(Buffer.from(JSON.stringify(obj), "utf8"));
}

export function signJwt(claims: JwtClaims, secret: string, expiresInSec = 3600): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body: JwtClaims = { iat: now, exp: now + expiresInSec, ...claims };
  const head = b64urlJson(header);
  const payload = b64urlJson(body);
  const sig = b64url(createHmac("sha256", secret).update(`${head}.${payload}`).digest());
  return `${head}.${payload}.${sig}`;
}

export function verifyJwt(token: string, secret: string): JwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new UnauthenticatedError("malformed token");
  const [head, payload, sig] = parts;
  const expected = b64url(createHmac("sha256", secret).update(`${head}.${payload}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new UnauthenticatedError("invalid token signature");
  }
  const claims = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as JwtClaims;
  if (claims.exp && Math.floor(Date.now() / 1000) > claims.exp) {
    throw new UnauthenticatedError("token expired");
  }
  return claims;
}

function principalFromClaims(claims: JwtClaims) {
  if (!claims.tenantId || !claims.orgId) throw new UnauthenticatedError("token missing tenant scope");
  return {
    userId: claims.sub,
    displayName: claims.name ?? claims.sub,
    email: claims.email ?? "",
    roles: claims.roles ?? [],
    tenantId: claims.tenantId,
    orgId: claims.orgId,
    positionId: claims.positionId,
    grants: claims.grants,
  };
}

/** Build a context authenticator backed by JWT bearer tokens. */
export function jwtAuthenticator(secret: string): Authenticator {
  return (headers) => {
    const header = headers.get("authorization");
    if (!header?.startsWith("Bearer ")) return null;
    return principalFromClaims(verifyJwt(header.slice(7), secret));
  };
}

/** Read a named cookie from a Cookie header. */
function readCookie(headers: Headers, name: string): string | null {
  const cookie = headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export const SESSION_COOKIE = "aula_session";

/** Authenticator backed by the httpOnly session JWT cookie set at login. */
export function sessionAuthenticator(secret: string): Authenticator {
  return (headers) => {
    const token = readCookie(headers, SESSION_COOKIE);
    if (!token) return null;
    return principalFromClaims(verifyJwt(token, secret));
  };
}

/** Switch the platform from dev auth to JWT auth. */
export function enableJwtAuth(secret: string): void {
  setAuthenticator(jwtAuthenticator(secret));
}
