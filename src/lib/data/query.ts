/**
 * Phase 5 — Query contracts.
 *
 * A small, type-safe query language shared by the API, query engine and
 * repository adapters. The in-memory adapter interprets it in JS today; a
 * PostgreSQL adapter would compile the same shape to WHERE/ORDER/LIMIT.
 */
import type { EntityRecord, FieldValue } from "@/lib/metadata/types";

export type FilterOperator =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "contains"
  | "in";

export interface Filter {
  field: string;
  op: FilterOperator;
  value: FieldValue | FieldValue[];
}

export type SortDirection = "asc" | "desc";

export interface Sort {
  field: string;
  dir: SortDirection;
}

export interface Query {
  filters?: Filter[];
  sort?: Sort[];
  page?: number;
  pageSize?: number;
  /** Free-text search term, matched against the entity's searchable fields. */
  search?: string;
}

/** Repository-level query: search already resolved to concrete field names. */
export interface RepoQuery {
  filters: Filter[];
  sort: Sort[];
  page: number;
  pageSize: number;
  search?: { term: string; fields: string[] };
}

export interface Page<T = EntityRecord> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

// ---- Aggregation (reports, AR aging, finance dashboards) ----

export type AggregateOp = "sum" | "count" | "avg" | "min" | "max";

export interface Measure {
  /** Field to aggregate (omitted for `count`). */
  field?: string;
  op: AggregateOp;
  /** Output key for the measure. */
  as: string;
}

export interface AggregateQuery {
  filters?: Filter[];
  /** Field to group by (omitted = single total row). */
  groupBy?: string;
  measures: Measure[];
}

export interface AggregateRow {
  /** Group key (null for the ungrouped total row). */
  key: string | null;
  measures: Record<string, number>;
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

export function normalizePaging(query: Query): { page: number; pageSize: number } {
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(query.pageSize ?? DEFAULT_PAGE_SIZE)));
  return { page, pageSize };
}
