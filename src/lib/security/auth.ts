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
  /** Not-before. Honoured with a small clock-skew tolerance. */
  nbf?: number;
  iss?: string;
  /** What the token may be used for — see `JWT_AUDIENCE`. */
  aud?: string;
  /** Unique id for THIS token, so one session can be withdrawn on its own. */
  jti?: string;
  /** The user's `tokenEpoch` at issue time — see lib/security/revocation. */
  epoch?: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(Buffer.from(JSON.stringify(obj), "utf8"));
}

/** The only algorithm this issuer uses, and the only one it will accept. */
const ALGORITHM = "HS256";

/**
 * Who minted the token, and what it may be used for.
 *
 * Bound so a token cannot be carried between purposes. One secret signing more
 * than one kind of value is a common shortcut — a session token, a
 * password-reset link, a webhook callback — and without these claims any of them
 * would validate as a session. Checking them costs nothing and closes the whole
 * class.
 */
export const JWT_ISSUER = "aula";
export const JWT_AUDIENCE = "aula-api";

/**
 * Tolerance for `nbf` and `iat`, in seconds.
 *
 * Server clocks drift, and a token that is a second "too new" is a clock
 * problem, not an attack. Deliberately NOT applied to `exp`: extending the life
 * of an expired token is the one direction where leniency costs something.
 */
const CLOCK_SKEW_SEC = 30;

export function signJwt(claims: JwtClaims, secret: string, expiresInSec = 3600): string {
  const header = { alg: ALGORITHM, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body: JwtClaims = { iat: now, exp: now + expiresInSec, iss: JWT_ISSUER, aud: JWT_AUDIENCE, ...claims };
  const head = b64urlJson(header);
  const payload = b64urlJson(body);
  const sig = b64url(createHmac("sha256", secret).update(`${head}.${payload}`).digest());
  return `${head}.${payload}.${sig}`;
}

/** Decode a base64url segment. Node's base64 decoder accepts the URL alphabet. */
function decodeSegment<T>(segment: string, what: string): T {
  try {
    return JSON.parse(Buffer.from(segment, "base64").toString("utf8")) as T;
  } catch {
    throw new UnauthenticatedError(`malformed token ${what}`);
  }
}

/**
 * Verify a token and return its claims.
 *
 * The header used to be ignored entirely — the signature was recomputed as
 * HMAC-SHA256 no matter what the token claimed. That was accidentally safe
 * against `alg: none` (the recomputed signature would not match an empty one),
 * and accidental safety is worth replacing with the deliberate kind: the moment
 * anyone adds a second algorithm keyed off the header, the old code becomes the
 * textbook algorithm-confusion vulnerability. So `alg` is now asserted, and
 * anything that is not exactly HS256 is refused by name.
 *
 * `exp` is REQUIRED rather than checked-if-present. A token without one never
 * expires, and "if the claim happens to be there" is a strange condition to hang
 * that on.
 */
export function verifyJwt(token: string, secret: string): JwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new UnauthenticatedError("malformed token");
  const [head, payload, sig] = parts as [string, string, string];

  // Signature FIRST. Everything below reads attacker-supplied JSON, and it
  // should only be read once we know it has not been tampered with.
  const expected = b64url(createHmac("sha256", secret).update(`${head}.${payload}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new UnauthenticatedError("invalid token signature");
  }

  const header = decodeSegment<{ alg?: string; typ?: string }>(head, "header");
  if (header.alg !== ALGORITHM) {
    throw new UnauthenticatedError(`unsupported token algorithm: ${String(header.alg)}`);
  }
  if (header.typ && header.typ !== "JWT") {
    throw new UnauthenticatedError("unsupported token type");
  }

  const claims = decodeSegment<JwtClaims>(payload, "payload");
  const now = Math.floor(Date.now() / 1000);

  if (typeof claims.exp !== "number") throw new UnauthenticatedError("token has no expiry");
  if (now > claims.exp) throw new UnauthenticatedError("token expired");
  if (typeof claims.nbf === "number" && now + CLOCK_SKEW_SEC < claims.nbf) {
    throw new UnauthenticatedError("token is not valid yet");
  }
  if (typeof claims.iat === "number" && claims.iat > now + CLOCK_SKEW_SEC) {
    // Issued in the future: either a badly skewed clock or a forged timestamp.
    throw new UnauthenticatedError("token issued in the future");
  }
  if (claims.iss !== JWT_ISSUER) throw new UnauthenticatedError("token from an unknown issuer");
  if (claims.aud !== JWT_AUDIENCE) throw new UnauthenticatedError("token is not for this API");

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
    jti: claims.jti,
    tokenEpoch: claims.epoch,
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
