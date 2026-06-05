/**
 * Phase 2 — Metadata system: strong typing contracts.
 *
 * Everything the platform does is driven by these definitions. Entities, fields,
 * list/record layouts and lifecycles are described here as data; the data layer,
 * permission engine, API and UI all read from them rather than hard-coding
 * per-entity behaviour.
 */

export type FieldType =
  | "string"
  | "text"
  | "number"
  | "currency"
  | "percent"
  | "boolean"
  | "date"
  | "datetime"
  | "email"
  | "phone"
  | "url"
  | "enum"
  | "reference";

export interface EnumOption {
  value: string;
  label: string;
  /** Optional semantic colour used by the UI badge renderer. */
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
}

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  unique?: boolean;
  readOnly?: boolean;
  /** Marks personally identifiable data — redacted in logs (Phase 13). */
  pii?: boolean;
  searchable?: boolean;
  sortable?: boolean;
  filterable?: boolean;
  helpText?: string;
  /** For `enum` fields. */
  options?: EnumOption[];
  /** For `reference` fields — the target entity name. */
  referenceEntity?: string;
  /** Minimum / maximum for number & currency, length for string. */
  min?: number;
  max?: number;
  defaultValue?: unknown;
  /**
   * Server-derived value (e.g. invoice total). Computed fields are never
   * accepted from clients on write and render read-only in the UI.
   */
  computed?: boolean;
  /**
   * For string fields: offer a pick-or-type datalist of values already present
   * in the data (e.g. Job Title), so users reuse defined values without an enum.
   */
  suggest?: boolean;
}

/** A finite-state lifecycle attached to an entity (Phase 7 consumes this). */
export interface LifecycleTransition {
  from: string;
  to: string;
  /** Action name a caller invokes to perform this transition. */
  action: string;
  /** Permission action required to run the transition (Phase 6). */
  requires?: string;
  /** Names of invariant guards that must pass (Phase 7). */
  guards?: string[];
}

export interface LifecycleDef {
  /** The enum field on the entity that holds the current state. */
  field: string;
  initial: string;
  states: string[];
  /** Terminal states that cannot transition further. */
  finalStates?: string[];
  transitions: LifecycleTransition[];
}

export interface ListColumn {
  field: string;
  width?: number;
}

/** Nav grouping for the grouped sidebar. */
export type EntityGroup =
  | "crm"
  | "sales"
  | "inventory"
  | "purchasing"
  | "accounting"
  | "projects"
  | "marketing"
  | "support"
  | "people"
  | "finance"
  | "branches"
  | "admin";

/** Default record view for the `[entity]` screen. */
export type ViewType = "table" | "board" | "calendar";

/** Master–detail link: this entity's records belong to a parent record. */
export interface ParentRef {
  /** Parent entity name. */
  entity: string;
  /** The reference field on this entity pointing at the parent. */
  field: string;
}

export interface EntityDef {
  name: string;
  label: string;
  pluralLabel: string;
  /** lucide-style icon key used by the nav (Phase 10). */
  icon?: string;
  /** The field used as the human-readable title of a record. */
  titleField: string;
  fields: FieldDef[];
  lifecycle?: LifecycleDef;
  /** Columns shown in the data-dense list view (Phase 10). */
  listColumns?: ListColumn[];
  /** Whether records are owner-scoped for ABAC (Phase 6). */
  ownable?: boolean;
  /** Sidebar group (default "crm"). */
  group?: EntityGroup;
  /** Default screen view (default "table"). */
  viewType?: ViewType;
  /** Board (kanban) config — the enum field whose values become columns. */
  board?: { groupByField: string };
  /** Calendar config — the date field events are placed on. */
  calendar?: { dateField: string };
  /** Line-item entities point at their parent and are hidden from the nav. */
  parent?: ParentRef;
  /** Hide from the main navigation (line items, lookup tables). */
  system?: boolean;
}

/** System columns present on every record, independent of metadata. */
export interface SystemFields {
  id: string;
  tenantId: string;
  orgId: string;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  /** Optimistic-concurrency token (Phase 5). */
  version: number;
}

export type FieldValue = string | number | boolean | null;

/** A persisted record: system fields plus metadata-defined values. */
export type EntityRecord = SystemFields & Record<string, FieldValue>;

/** A versioned, publishable metadata document. */
export type MetadataStatus = "draft" | "published" | "archived";

export interface MetadataVersion {
  version: number;
  status: MetadataStatus;
  publishedAt: string | null;
  publishedBy: string | null;
  entities: Record<string, EntityDef>;
}
