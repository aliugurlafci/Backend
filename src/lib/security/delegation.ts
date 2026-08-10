/**
 * Delegation limits — nobody may grant more than they hold.
 *
 * A position that is allowed to manage other positions can still only hand out
 * the operations and screens it has itself. The permission catalogue served to
 * such a caller is narrowed to their own grants (so the matrix never shows a
 * privilege they cannot delegate), and every write is re-checked here, since the
 * catalogue is only a UI affordance.
 *
 * Administrators hold `*` and are unaffected.
 */
import { screenCatalog } from "@/lib/config/screens";
import type { SettingsAreaDef } from "@/lib/config/settings-permissions";
import type { RequestContext } from "@/lib/context/types";
import { ForbiddenError } from "@/lib/enforcement/errors";
import { metadata } from "@/lib/metadata";
import { grantMatches, grantsFor } from "@/lib/permissions/policies";
import { getPosition, parseScreens } from "./auth-service";
import { isAdmin } from "./visibility";

/** The caller's effective grants (position matrix, else role defaults). */
export function callerGrants(rc: RequestContext): string[] {
  return rc.grants ? [...rc.grants] : [...grantsFor(rc.roles)];
}

/** Does the caller's grant set fully cover `grant` (wildcards included)? */
export function covers(grants: readonly string[], grant: string): boolean {
  return grants.some((held) => grantMatches(held, grant));
}

/** The screen keys the caller may hand out — their own position's screens. */
export async function callerScreens(rc: RequestContext): Promise<Set<string>> {
  if (isAdmin(rc)) return new Set(screenCatalog(metadata).map((s) => s.key));
  const position = rc.positionId ? await getPosition(rc.positionId) : null;
  return new Set(parseScreens(position));
}

/** Reject a permission list containing anything the caller does not hold. */
export function assertGrantsDelegatable(rc: RequestContext, permissions: readonly string[]): void {
  if (isAdmin(rc)) return;
  const held = callerGrants(rc);
  const excess = permissions.filter((g) => !covers(held, g));
  if (excess.length) {
    throw new ForbiddenError(`you cannot grant permissions you do not hold: ${excess.slice(0, 5).join(", ")}`).withKey("err.grantExcess", { list: excess.slice(0, 5).join(", ") });
  }
}

/** Reject a screen list containing screens the caller cannot open themselves. */
export async function assertScreensDelegatable(rc: RequestContext, screens: readonly string[]): Promise<void> {
  if (isAdmin(rc)) return;
  const own = await callerScreens(rc);
  const excess = screens.filter((s) => !own.has(s));
  if (excess.length) {
    throw new ForbiddenError(`you cannot grant screens you cannot open: ${excess.slice(0, 5).join(", ")}`).withKey("err.screenExcess", { list: excess.slice(0, 5).join(", ") });
  }
}

export interface PermissionCatalogShape {
  entities: { name: string; group: string; actions: string[] }[];
  special: string[];
  roles: { value: string; grants: string[] }[];
  settings: SettingsAreaDef[];
}

/**
 * Narrow a permission catalogue to what this caller may delegate. Entities and
 * areas with nothing left are dropped entirely, so the matrix shows only real
 * choices. The data-model area is administrator-only regardless of grants.
 */
export function narrowCatalog(rc: RequestContext, catalog: PermissionCatalogShape): PermissionCatalogShape {
  const admin = isAdmin(rc);
  const settings = catalog.settings.filter((a) => admin || !ADMIN_ONLY_SETTINGS_AREAS.has(a.key));
  if (admin) return { ...catalog, settings };

  const held = callerGrants(rc);
  const entities = catalog.entities
    .map((e) => ({ ...e, actions: e.actions.filter((a) => covers(held, `${e.name}:${a}`)) }))
    .filter((e) => e.actions.length > 0);
  const narrowedSettings = settings
    .map((a) => ({ ...a, actions: a.actions.filter((op) => covers(held, `${a.key}:${op}`)) }))
    .filter((a) => a.actions.length > 0);

  return {
    entities,
    special: catalog.special.filter((g) => covers(held, g)),
    // Presets are starting points, so they are clipped to what the caller holds;
    // the administrator preset is never offered.
    roles: catalog.roles
      .filter((r) => r.value !== "admin")
      .map((r) => ({ value: r.value, grants: r.grants.filter((g) => covers(held, g)) })),
    settings: narrowedSettings,
  };
}

/**
 * Settings areas only an administrator may see or delegate. Empty today — the
 * data model, the one administrator-only section, is not a grantable area at all
 * (see lib/config/settings-permissions) — but the hook stays so a future
 * infrastructure section can be kept out of the matrix in one place.
 */
export const ADMIN_ONLY_SETTINGS_AREAS = new Set<string>();
