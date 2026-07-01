/**
 * Mobile screen configuration — resolves which screens the companion app may
 * show a given user, and serves the admin catalog/CRUD behind the `/mobile/*`
 * endpoints. The effective set is always the admin-curated `mobileScreenConfig`
 * intersected with the user's own screen permissions, so enabling a screen for
 * mobile never grants access a user wouldn't already have on the web.
 *
 * Resolution precedence (most specific active row wins): user > position >
 * client-default; within a tier an exact `clientId` beats the `*` wildcard.
 */
import type { RequestContext } from "@/lib/context/types";
import type { EntityRecord } from "@/lib/metadata/types";
import { systemContext } from "@/lib/context/resolver";
import { getDomainService } from "@/lib/domain";
import { metadata } from "@/lib/metadata";
import { screenCatalog, entityScreens, MOBILE_IMPLEMENTED_SCREENS, MOBILE_SUPPORTED_EXTRAS, type ScreenDef } from "@/lib/config/screens";
import { getPosition, parseScreens } from "@/lib/security/auth-service";

export interface MobileScreenDef extends ScreenDef {
  /** True when the mobile app actually has a destination for this key. */
  mobileImplemented: boolean;
}

export interface ResolvedMobileConfig {
  clientId: string;
  /** Screen keys the app may show this user (config ∩ permissions). */
  screens: string[];
  /** Per-entity field names to hide on mobile: { entity: [field,…] }. */
  hiddenFields: Record<string, string[]>;
  /** Content hash — the client polls this to detect a config change cheaply. */
  version: string;
}

const DEFAULT_SCREENS: string[] = [...MOBILE_IMPLEMENTED_SCREENS];

/**
 * The full catalog flagged with which screens the mobile app implements. Every
 * entity screen is covered by the app's generic entity browser, and the supported
 * extras (dashboards, activity, comms/admin tools) by the generic hosts — so the
 * admin UI only marks a screen "web-only" if it's neither.
 */
export function mobileScreenCatalog(): MobileScreenDef[] {
  const supported = new Set<string>(MOBILE_SUPPORTED_EXTRAS);
  const entityKeys = new Set<string>(entityScreens(metadata).map((e) => e.key));
  return screenCatalog(metadata).map((s) => ({
    ...s,
    mobileImplemented: supported.has(s.key) || entityKeys.has(s.key),
  }));
}

/** Stable, order-insensitive content hash (djb2) used as the config version. */
function stableVersion(screens: string[], hiddenFields: Record<string, string[]>): string {
  const payload = JSON.stringify({ s: [...screens].sort(), h: hiddenFields });
  let h = 5381;
  for (let i = 0; i < payload.length; i++) h = ((h << 5) + h + payload.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseHiddenFields(value: unknown): Record<string, string[]> {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [entity, fields] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(fields)) out[entity] = fields.map(String);
    }
    return out;
  } catch {
    return {};
  }
}

const str = (v: unknown): string => String(v ?? "").trim();

/** Does an admin row apply to this caller + client, and how specific is it? */
function score(row: EntityRecord, rc: RequestContext, clientId: string): number | null {
  const rowUser = str(row.userId);
  const rowPos = str(row.positionId);
  const rowClient = str(row.clientId) || "*";
  if (rowUser && rowUser !== rc.userId) return null;
  if (rowPos && rowPos !== (rc.positionId ?? "")) return null;
  if (rowClient !== "*" && rowClient !== clientId) return null;
  return (rowUser ? 100 : 0) + (rowPos ? 50 : 0) + (rowClient !== "*" ? 5 : 0);
}

/** Resolve the effective mobile config for the caller (default client `*`). */
export async function resolveMobileConfig(rc: RequestContext, clientId = "*"): Promise<ResolvedMobileConfig> {
  const client = str(clientId) || "*";
  const domain = await getDomainService();
  const sys = systemContext(rc.tenantId, rc.orgId);
  const rows = await domain.list(sys, "mobileScreenConfig", {
    filters: [{ field: "active", op: "eq", value: true }],
    pageSize: 500,
  });

  // Pick the most specific applicable row (highest score, newest on a tie).
  let best: EntityRecord | null = null;
  let bestScore = -1;
  for (const row of rows.items) {
    const s = score(row, rc, client);
    if (s === null) continue;
    if (s > bestScore || (s === bestScore && str(row.updatedAt) > str(best?.updatedAt))) {
      best = row;
      bestScore = s;
    }
  }

  const configured = best ? parseJsonArray(best.screens) : DEFAULT_SCREENS;
  const hiddenFields = best ? parseHiddenFields(best.hiddenFields) : {};

  // Intersect with the user's own permitted screens so mobile never widens access.
  const position = rc.positionId ? await getPosition(rc.positionId) : null;
  const allowed = position ? new Set(parseScreens(position)) : null; // null = admin/persona (all)
  const screens = configured.filter((key) => !allowed || allowed.has(key));

  return { clientId: client, screens, hiddenFields, version: stableVersion(screens, hiddenFields) };
}
