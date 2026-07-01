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
  { key: "deals-dashboard", label: "Deals Dashboard", group: "dashboards" },
  { key: "inventory-dashboard", label: "Inventory Dashboard", group: "dashboards" },
  { key: "accounting-dashboard", label: "Accounting Dashboard", group: "dashboards" },
  { key: "branch-dashboard", label: "Branch Dashboard", group: "dashboards" },
  { key: "executive-dashboard", label: "Executive Dashboard", group: "dashboards" },
  { key: "revenue-dashboard", label: "Revenue Dashboard", group: "dashboards" },
  { key: "growth-dashboard", label: "Growth Dashboard", group: "dashboards" },
  { key: "pipeline", label: "Pipeline", group: "sales" },
  { key: "pos", label: "Point of Sale", group: "sales" },
  { key: "cart", label: "Cart", group: "sales" },
  { key: "salesReturn", label: "Sales Returns", group: "sales" },
  { key: "stock-levels", label: "Stock Levels", group: "inventory" },
  { key: "label-designer", label: "Label Designer", group: "inventory" },
  { key: "labels", label: "Label Printing", group: "inventory" },
  { key: "email", label: "Email", group: "comms" },
  { key: "calendar", label: "Calendar", group: "comms" },
  { key: "file-manager", label: "Files", group: "comms" },
  { key: "todo", label: "To Do", group: "comms" },
  { key: "notes", label: "Notes", group: "comms" },
  { key: "reports", label: "Reports", group: "finance" },
  { key: "finance", label: "Finance", group: "finance" },
  { key: "automation", label: "Automation", group: "admin" },
  { key: "activity", label: "Activity", group: "admin" },
  { key: "settings", label: "Settings", group: "admin" },
];

/**
 * Screen keys the companion mobile app actually implements a destination for.
 * Admins may toggle any catalog screen for mobile, but only these render on a
 * phone — the mobile gate intersects the configured set with this list, and the
 * admin UI flags the rest as "web-only". Keys are drawn from the shared catalog.
 */
export const MOBILE_IMPLEMENTED_SCREENS = [
  "home",
  "pos",
  "cart",
  "salesReturn",
  "stock-levels",
  "product",
  "labels",
  "label-designer",
  "settings",
] as const;

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
