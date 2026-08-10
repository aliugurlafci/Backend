/**
 * Helpers shared by more than one route module.
 *
 * Everything here was a private function in the single `api.ts`. What earned a
 * place in this file is only what two or more domains genuinely need — a helper
 * used by one router lives with that router, so this does not become the new
 * dumping ground the split was meant to undo.
 */
import { grantsFor } from "@/lib/permissions/policies";
import { canSettings } from "@/lib/config/settings-permissions";
import { BadRequestError, ForbiddenError } from "@/lib/enforcement/errors";
import { assertPositionVisible, assertUserVisible } from "@/lib/security/visibility";
import { assertGrantsDelegatable, assertScreensDelegatable } from "@/lib/security/delegation";
import type { EntityRecord } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";

/** Minimum length for any password set through the API. */
const MIN_PASSWORD_LEN = 8;

/**
 * The administrator gate for endpoints that are not covered by the permission
 * matrix at all — the automation platform, system settings and the metrics
 * counters. Distinct from {@link assertSettings}, which asks whether a
 * position was granted one specific Settings operation; this asks the blunter
 * question, for surfaces that have no finer-grained grant to check.
 */
export const adminOnly = (rc: { roles: readonly string[] }): void => {
  if (!rc.roles.includes("admin")) throw new ForbiddenError("admins only");
};

/** Reject weak passwords (applied to self-service change + admin create/reset). */
export function assertPasswordStrength(pw: string): void {
  if (!pw || pw.length < MIN_PASSWORD_LEN) {
    throw new BadRequestError(`password must be at least ${MIN_PASSWORD_LEN} characters`).withKey("err.passwordTooShort", { min: MIN_PASSWORD_LEN });
  }
}

/** Drop the password hash + 2FA secret before returning a user record to a client. */
export function stripHash(user: EntityRecord): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...user };
  delete rest.passwordHash;
  delete rest.twoFactorSecret;
  return rest;
}

/** The caller's effective grants — the position's matrix, else its role defaults. */
export function effectiveGrants(rc: RequestContext): string[] {
  return rc.grants ? [...rc.grants] : [...grantsFor(rc.roles)];
}

/**
 * Gate one Settings-screen operation (see lib/config/settings-permissions).
 * Administrators hold `*` and pass everything; every other position needs the
 * area grant the admin ticked in the permission matrix.
 */
export function assertSettings(rc: RequestContext, area: string, action: string): void {
  if (!canSettings(effectiveGrants(rc), area, action)) {
    throw new ForbiddenError(`this position is not granted "${area}:${action}"`).withKey("err.grantMissing", { grant: `${area}:${action}` });
  }
}

/**
 * Administrative visibility for the two system entities reachable through the
 * generic CRUD routes. Everything else is governed by the permission engine
 * alone; `user` and `position` additionally hide administrators and stay inside
 * the caller's creation subtree.
 */
export async function assertAdminRecordVisible(rc: RequestContext, entity: string, id: string): Promise<void> {
  if (entity === "user") await assertUserVisible(rc, id);
  else if (entity === "position") await assertPositionVisible(rc, id);
}

/** Parse a JSON-text array field ("[\"a\",\"b\"]") from an entity payload. */
export function jsonArrayField(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

/**
 * A position write may never carry screens or grants the caller lacks — the
 * editor already hides them, this is the enforcement behind it.
 */
export async function assertPositionPayloadDelegatable(rc: RequestContext, body: Record<string, unknown>): Promise<void> {
  const screens = jsonArrayField(body.screens);
  if (screens) await assertScreensDelegatable(rc, screens);
  const permissions = jsonArrayField(body.permissions);
  if (permissions) assertGrantsDelegatable(rc, permissions);
}

/**
 * A mobile visibility rule may only mention screens the caller can open, and
 * may only target a position/user inside their own subtree.
 */
export async function assertMobileConfigDelegatable(rc: RequestContext, body: Record<string, unknown>): Promise<void> {
  const screens = jsonArrayField(body.screens);
  if (screens) await assertScreensDelegatable(rc, screens);
  if (body.positionId) await assertPositionVisible(rc, String(body.positionId));
  if (body.userId) await assertUserVisible(rc, String(body.userId));
}

/**
 * Header discount, as the document entities store it.
 *
 * Spread into every create call rather than defaulted in the service, because
 * `replaceLines` reads these back off the record when it recomputes totals — a
 * document created without them recomputes as if no discount was ever given,
 * and the request that asked for one gets a full-price document with no error.
 */
export function headerDiscount(b: { discountRate?: number; discountAmount?: number }): Record<string, number> {
  return { discountRate: Number(b.discountRate ?? 0), discountAmount: Number(b.discountAmount ?? 0) };
}
