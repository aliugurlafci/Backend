/**
 * Screen catalog — the set of navigable destinations access can be granted for.
 *
 * Entity screens are derived from non-system metadata (one per entity); the
 * "extra" screens below are the dashboards, comms tools and admin pages that
 * aren't plain entity lists. A position's `screens` field stores a JSON array of
 * these keys. Keys match the first path segment of each route.
 */
import type { MetadataResolver } from "@/lib/metadata/resolver";

export interface ScreenDef {
  key: string;
  label: string;
  group: string;
}

/** Non-entity screens (keys equal the route's first segment; "home" is `/`). */
export const EXTRA_SCREENS: ScreenDef[] = [
  { key: "home", label: "Dashboard", group: "main" },
  { key: "sales-dashboard", label: "Sales Dashboard", group: "dashboards" },
  { key: "leads-dashboard", label: "Leads Dashboard", group: "dashboards" },
  { key: "deals-dashboard", label: "Deals Dashboard", group: "dashboards" },
  { key: "inventory-dashboard", label: "Inventory Dashboard", group: "dashboards" },
  { key: "accounting-dashboard", label: "Accounting Dashboard", group: "dashboards" },
  { key: "branch-dashboard", label: "Branch Dashboard", group: "dashboards" },
  { key: "executive-dashboard", label: "Executive Dashboard", group: "dashboards" },
  { key: "revenue-dashboard", label: "Revenue Dashboard", group: "dashboards" },
  { key: "growth-dashboard", label: "Growth Dashboard", group: "dashboards" },
  { key: "calendar", label: "Calendar", group: "crm" },
  { key: "activity", label: "Activity", group: "crm" },
  { key: "pipeline", label: "Pipeline", group: "sales" },
  { key: "email", label: "Email", group: "comms" },
  { key: "chat", label: "Chat", group: "comms" },
  { key: "calls", label: "Calls", group: "comms" },
  { key: "file-manager", label: "Files", group: "comms" },
  { key: "todo", label: "To Do", group: "comms" },
  { key: "notes", label: "Notes", group: "comms" },
  { key: "reports", label: "Reports", group: "finance" },
  { key: "finance", label: "Finance", group: "finance" },
  { key: "automation", label: "Automation", group: "admin" },
  { key: "settings", label: "Settings", group: "admin" },
];

/** One screen per non-system entity (its list/detail screen). */
export function entityScreens(metadata: MetadataResolver): ScreenDef[] {
  return metadata
    .listEntities()
    .filter((e) => !e.system)
    .map((e) => ({ key: e.name, label: e.pluralLabel, group: e.group ?? "crm" }));
}

/** The full catalog: entity screens + extras. */
export function screenCatalog(metadata: MetadataResolver): ScreenDef[] {
  return [...entityScreens(metadata), ...EXTRA_SCREENS];
}

/** Map a route pathname to its screen key (the first segment; `/` ⇒ "home"). */
export function screenKeyForPath(pathname: string): string {
  if (!pathname || pathname === "/") return "home";
  const seg = pathname.split("/").filter(Boolean)[0];
  return seg ?? "home";
}
