/**
 * Settings permission catalog — the Settings screen broken down into individually
 * grantable areas and operations.
 *
 * Screen access ("may this position open /settings at all?") is coarse: one
 * `settings` key in the screen catalog. This catalog is the fine-grained layer on
 * top of it — every section of the Settings screen, and every operation inside a
 * section, is its own grant so a position can e.g. read the user list without
 * being able to reset passwords.
 *
 * Grants are plain `<area>:<action>` strings — the same shape (and the same
 * wildcard rules) the entity matrix uses, so they live in a position's
 * `permissions` array alongside `deal:update` and friends and need no engine
 * change. Areas are namespaced under `settings.` to keep them off the entity map.
 *
 * Mirrored verbatim in Frontend/src/lib/config/settings-permissions.ts.
 */

/** Matrix groups the areas are rendered under in the position editor. */
export type SettingsGroup = "settingsPersonal" | "settingsWorkspace" | "settingsAdmin";

export interface SettingsAreaDef {
  /** Grant prefix — grants are `${key}:${action}` (e.g. `settings.users:create`). */
  key: string;
  /** English fallback label (the UI renders the localized `perm.area.<key>` key). */
  label: string;
  group: SettingsGroup;
  /** Grantable operations, in display order. */
  actions: string[];
  /** Route this area gates, for areas that own a page under /settings. */
  href?: string;
  /**
   * Personal (self-service) area: every base role gets it by default, since
   * managing one's own profile/password/theme isn't an administrative privilege.
   */
  selfService?: boolean;
}

/**
 * Every grantable Settings area. Keys are stable identifiers — renaming one
 * silently drops the grant from existing positions, so add rather than rename.
 */
export const SETTINGS_AREAS: SettingsAreaDef[] = [
  // ---- personal (self-service) ----------------------------------------
  {
    key: "settings.profile",
    label: "Profile",
    group: "settingsPersonal",
    href: "/settings/profile",
    selfService: true,
    actions: ["read", "update", "avatar"],
  },
  {
    key: "settings.security",
    label: "Security",
    group: "settingsPersonal",
    href: "/settings/security",
    selfService: true,
    actions: ["read", "password", "twoFactor", "activity"],
  },
  {
    key: "settings.notifications",
    label: "Notifications",
    group: "settingsPersonal",
    href: "/settings/notifications",
    selfService: true,
    actions: ["read", "update", "mailSync"],
  },
  {
    key: "settings.appearance",
    label: "Appearance",
    group: "settingsPersonal",
    href: "/settings/appearance",
    selfService: true,
    actions: ["read", "update"],
  },

  // ---- workspace ------------------------------------------------------
  {
    key: "settings.workspace",
    label: "Workspace & account",
    group: "settingsWorkspace",
    selfService: true,
    actions: ["read"],
  },
  { key: "settings.featureFlags", label: "Feature flags", group: "settingsWorkspace", actions: ["read"] },
  { key: "settings.metadata", label: "Data model", group: "settingsWorkspace", actions: ["read", "publish"] },
  { key: "settings.import", label: "Data import", group: "settingsWorkspace", actions: ["read", "execute"] },
  { key: "settings.export", label: "Data export", group: "settingsWorkspace", actions: ["read", "execute"] },
  { key: "settings.releases", label: "Release & audit trail", group: "settingsWorkspace", actions: ["read"] },

  // ---- administration -------------------------------------------------
  {
    key: "settings.roles",
    label: "Positions & permissions",
    group: "settingsAdmin",
    href: "/settings/roles",
    actions: ["read", "create", "update", "delete"],
  },
  {
    key: "settings.users",
    label: "User management",
    group: "settingsAdmin",
    href: "/settings/users",
    actions: ["read", "create", "update", "password", "twoFactor", "activate"],
  },
  {
    key: "settings.mobile",
    label: "Mobile screens",
    group: "settingsAdmin",
    href: "/settings/mobile",
    actions: ["read", "create", "update", "delete"],
  },
];

export const SETTINGS_AREA_BY_KEY: Record<string, SettingsAreaDef> = Object.fromEntries(
  SETTINGS_AREAS.map((a) => [a.key, a]),
);

/** Personal areas — the defaults every base role carries (see policies.ts). */
export const SELF_SERVICE_SETTINGS_GRANTS: string[] = SETTINGS_AREAS.filter((a) => a.selfService).map(
  (a) => `${a.key}:*`,
);

const SELF_SERVICE_KEYS = new Set(SETTINGS_AREAS.filter((a) => a.selfService).map((a) => a.key));

/**
 * Entity grants a settings grant implies.
 *
 * The administrative Settings screens read and write real records (`user`,
 * `position`), and those go through the ordinary permission engine. Both are
 * *system* entities, so they never appear in the entity matrix — granting the
 * area has to carry the data access it needs, or the screen would render and
 * then fail on every request. `pii:read` rides along with the user list because
 * managing accounts means seeing their email addresses.
 */
export const SETTINGS_IMPLIED_GRANTS: Record<string, string[]> = {
  "settings.roles:read": ["position:read"],
  "settings.roles:create": ["position:read", "position:create"],
  "settings.roles:update": ["position:read", "position:update"],
  "settings.roles:delete": ["position:read", "position:delete"],
  "settings.users:read": ["user:read", "position:read", "pii:read"],
  "settings.users:create": ["user:read", "user:create", "position:read", "pii:read"],
  "settings.users:update": ["user:read", "user:update", "position:read", "pii:read"],
  "settings.users:password": ["user:read", "user:update", "pii:read"],
  "settings.users:twoFactor": ["user:read", "user:update", "pii:read"],
  "settings.users:activate": ["user:read", "user:update", "pii:read"],
  "settings.mobile:read": ["position:read", "user:read", "pii:read"],
};

/**
 * Expand a stored permission list with the entity grants its settings grants
 * imply. Applied when a session's effective grants are resolved, so the stored
 * matrix stays declarative (only what the admin ticked) while the engine sees
 * the access those ticks actually require.
 */
export function expandSettingsGrants(grants: readonly string[]): string[] {
  const out = new Set(grants);
  for (const grant of grants) {
    if (!grant.startsWith("settings.")) continue;
    const [area, verb] = grant.split(":");
    const actions = verb === "*" ? (SETTINGS_AREA_BY_KEY[area]?.actions ?? []) : [verb];
    for (const action of actions) {
      for (const implied of SETTINGS_IMPLIED_GRANTS[`${area}:${action}`] ?? []) out.add(implied);
    }
  }
  return [...out];
}

/** True for a grant that talks about a settings area (used for the legacy check). */
function isSettingsGrant(grant: string): boolean {
  return grant.startsWith("settings.");
}

/**
 * Wildcard-aware match, identical in semantics to `grantMatches` in the
 * permission policies. Duplicated here (six lines) so this catalog stays a leaf
 * module — the policies import the self-service defaults from it.
 */
function grantCovers(grant: string, target: string): boolean {
  if (grant === "*" || grant === target) return true;
  const [gArea, gVerb] = grant.split(":");
  const [tArea, tVerb] = target.split(":");
  if (gVerb === "*" && gArea === tArea) return true;
  if (gArea === "*" && gVerb === tVerb) return true;
  return false;
}

/**
 * May a grant set perform `action` on a settings area?
 *
 * Backward compatibility: positions saved before settings permissions existed
 * carry an explicit permission list with no `settings.*` entry at all. Locking
 * those users out of their own profile would be a regression, so a grant set
 * that mentions no settings area keeps the self-service (personal) areas.
 * Anything administrative still requires an explicit grant.
 */
export function canSettings(grants: Iterable<string>, key: string, action: string): boolean {
  const list = [...grants];
  const target = `${key}:${action}`;
  if (list.some((g) => grantCovers(g, target))) return true;
  return SELF_SERVICE_KEYS.has(key) && !list.some(isSettingsGrant);
}

/** True when at least one action of the area is granted (section visibility). */
export function canAnySettings(grants: Iterable<string>, key: string): boolean {
  const actions = SETTINGS_AREA_BY_KEY[key]?.actions ?? ["read"];
  return actions.some((a) => canSettings(grants, key, a));
}

/**
 * Which settings area governs a `userSetting` key written through
 * `PATCH /auth/settings` (theme/accent/… vs. the mail-sync cadence).
 */
export function areaForUserSettingKey(key: string): { area: string; action: string } {
  if (key === "mailSyncInterval") return { area: "settings.notifications", action: "mailSync" };
  return { area: "settings.appearance", action: "update" };
}
