/**
 * Credential authentication + screen-access resolution.
 *
 * Looks users up in the `user` table, verifies the scrypt password hash, then
 * derives the data-role + allowed screens from the user's `position`. Issues the
 * same HS256 JWT used elsewhere (carrying `positionId`) for the session cookie.
 */
import { systemContext } from "@/lib/context/resolver";
import { getQueryEngine } from "@/lib/data/store";
import type { EntityRecord } from "@/lib/metadata/types";
import { DEMO_ORG, DEMO_TENANT } from "@/lib/context/dev";
import { env, jwtSecret } from "@/lib/config/env";
import { verifyPassword } from "./crypto";
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

export interface LoginResult {
  token: string;
  expiresIn: number;
  user: { id: string; email: string; displayName: string; roles: string[]; positionId: string | null };
  position: { id: string; name: string; role: string } | null;
  screens: string[];
}

/** Verify credentials and return a signed session token + the user's access. */
export async function login(email: string, password: string): Promise<LoginResult | null> {
  const user = await findUserByEmail(email);
  if (!user || user.active === false) return null;
  if (!verifyPassword(password, String(user.passwordHash ?? ""))) return null;

  const position = user.positionId ? await getPosition(String(user.positionId)) : null;
  const role = position ? String(position.role) : "sales_rep";
  const screens = parseScreens(position);

  const token = signJwt(
    {
      sub: user.id,
      name: String(user.displayName ?? user.email),
      email: String(user.email),
      roles: [role],
      tenantId: user.tenantId,
      orgId: user.orgId,
      positionId: position ? position.id : undefined,
    },
    jwtSecret,
    env.AULA_JWT_TTL,
  );

  return {
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
  };
}
