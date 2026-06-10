/**
 * Credential authentication + screen-access resolution.
 *
 * Looks users up in the `user` table, verifies the scrypt password hash, then
 * derives the data-role + allowed screens from the user's `position`. Issues the
 * same HS256 JWT used elsewhere (carrying `positionId`) for the session cookie.
 */
import { systemContext } from "@/lib/context/resolver";
import { getQueryEngine } from "@/lib/data/store";
import { systemClock } from "@/lib/core/clock";
import type { EntityRecord } from "@/lib/metadata/types";
import { DEMO_ORG, DEMO_TENANT } from "@/lib/context/dev";
import { env, jwtSecret } from "@/lib/config/env";
import { decrypt, totpVerify, verifyPassword } from "./crypto";
import { signJwt } from "./auth";

/** A privileged context for auth lookups (bypasses RBAC for self-resolution). */
const sys = () => systemContext(DEMO_TENANT, DEMO_ORG);

export async function findUserByEmail(email: string): Promise<EntityRecord | null> {
  const qe = await getQueryEngine();
  const page = await qe.list(sys(), "user", {
    filters: [{ field: "email", op: "eq", value: email.trim().toLowerCase() }],
    pageSize: 1,
  });
  return page.items[0] ?? null;
}

export async function getPosition(id: string): Promise<EntityRecord | null> {
  const qe = await getQueryEngine();
  try {
    return await qe.get(sys(), "position", id);
  } catch {
    return null;
  }
}

/** Fetch a user record by id (null if missing, e.g. for dev personas). */
export async function findUserById(id: string): Promise<EntityRecord | null> {
  const qe = await getQueryEngine();
  try {
    return await qe.get(sys(), "user", id);
  } catch {
    return null;
  }
}

/** Parse a position's `screens` JSON field into a list of screen keys. */
export function parseScreens(position: EntityRecord | null): string[] {
  if (!position) return [];
  try {
    const parsed = JSON.parse(String(position.screens ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Parse a position's `permissions` JSON field into a list of operation grants. */
export function parsePermissions(position: EntityRecord | null): string[] {
  if (!position?.permissions) return [];
  try {
    const parsed = JSON.parse(String(position.permissions));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * The explicit grant list to embed in a session token, or undefined to let the
 * engine fall back to the base role's defaults. Admins are always super-users
 * (no embedded matrix), and an empty matrix inherits the role — so only a
 * customised non-admin position carries an authoritative grant list.
 */
export function grantsClaimFor(role: string, position: EntityRecord | null): string[] | undefined {
  if (role === "admin") return undefined;
  const explicit = parsePermissions(position);
  return explicit.length ? explicit : undefined;
}

export interface LoginResult {
  token: string;
  expiresIn: number;
  user: { id: string; email: string; displayName: string; roles: string[]; positionId: string | null };
  position: { id: string; name: string; role: string } | null;
  screens: string[];
}

/** Result of a login attempt: success, an extra 2FA step, a bad code, or bad creds. */
export type LoginOutcome =
  | { status: "ok"; userId: string; tenantId: string; orgId: string; result: LoginResult }
  | { status: "2fa_required" }
  | { status: "invalid_code" }
  | { status: "invalid" };

/** Verify credentials (+ a TOTP code when 2FA is on) and mint a session token. */
export async function login(email: string, password: string, code?: string): Promise<LoginOutcome> {
  const user = await findUserByEmail(email);
  if (!user || user.active === false) return { status: "invalid" };
  if (!verifyPassword(password, String(user.passwordHash ?? ""))) return { status: "invalid" };

  // Second factor (TOTP) when enabled.
  if (user.twoFactorEnabled) {
    if (!code) return { status: "2fa_required" };
    let secret = "";
    try {
      secret = user.twoFactorSecret ? decrypt(String(user.twoFactorSecret)) : "";
    } catch {
      secret = "";
    }
    if (!secret || !totpVerify(secret, code)) return { status: "invalid_code" };
  }

  const position = user.positionId ? await getPosition(String(user.positionId)) : null;
  const role = position ? String(position.role) : "sales_rep";
  const screens = parseScreens(position);
  const grants = grantsClaimFor(role, position);

  const token = signJwt(
    {
      sub: user.id,
      name: String(user.displayName ?? user.email),
      email: String(user.email),
      roles: [role],
      tenantId: user.tenantId,
      orgId: user.orgId,
      positionId: position ? position.id : undefined,
      grants,
    },
    jwtSecret,
    env.AULA_JWT_TTL,
  );

  return {
    status: "ok",
    userId: String(user.id),
    tenantId: String(user.tenantId),
    orgId: String(user.orgId),
    result: {
      token,
      expiresIn: env.AULA_JWT_TTL,
      user: {
        id: user.id,
        email: String(user.email),
        displayName: String(user.displayName ?? ""),
        roles: [role],
        positionId: position ? position.id : null,
      },
      position: position ? { id: position.id, name: String(position.name), role } : null,
      screens,
    },
  };
}

/** Append a security-activity record (never throws — auth must not fail on logging). */
export async function recordSecurityEvent(
  scope: { tenantId: string; orgId: string },
  userId: string,
  type: "sign_in" | "password_changed" | "twofactor_enabled" | "twofactor_disabled",
  meta?: { ip?: string | null; userAgent?: string | null },
): Promise<void> {
  try {
    const qe = await getQueryEngine();
    await qe.create(systemContext(scope.tenantId, scope.orgId), "securityEvent", {
      userId,
      type,
      ip: meta?.ip ?? null,
      userAgent: (meta?.userAgent ?? "").slice(0, 400) || null,
      at: systemClock.isoNow(),
    });
  } catch {
    /* logging is best-effort */
  }
}
