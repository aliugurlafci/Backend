/**
 * SQL repository adapter (SQL Server + MySQL).
 *
 * Implements the tenant-scoped `Repository` contract using fully parameterised
 * queries (no string interpolation of values — injection safe). All enforcement
 * (permissions, validation, isolation rules) lives above this in the query
 * engine; this adapter just translates the query language to WHERE / ORDER BY /
 * pagination / GROUP BY and maps optimistic concurrency to version-guarded
 * UPDATE/DELETE.
 *
 * The dialect-specific rendering (identifier quoting, placeholders, pagination,
 * inserted-id retrieval, LIKE/ESCAPE) comes from the active {@link SqlDialect};
 * the active {@link SqlDriver} binds parameters, runs the statement and owns
 * transactions + deadlock retries. Both are selected by `DB_CLIENT`.
 */
import { BadRequestError, ConflictError } from "@/lib/enforcement/errors";
import { logger } from "@/lib/observability/logger";
import type { EntityRecord } from "@/lib/metadata/types";
import type { MetadataResolver } from "@/lib/metadata/resolver";
import type { TenantScope } from "@/lib/context/types";
import type { Repository } from "../repository";
import {
  normalizeAggregate,
  type AggregateQuery,
  type AggregateRow,
  type Cursor,
  type Filter,
  type Page,
  type RepoQuery,
  type Sort,
  type SortDirection,
} from "../query";
import { getDriver, type SqlDriver } from "./driver";
import { getDialect, type SqlDialect } from "./dialect";
import { T, type BoundParam, type SqlType } from "./types";
import {
  entityColumns,
  isIdLike,
  sqlTypeForColumn,
  toStorage,
  type ColumnDesc,
} from "./schema-map";

/** Accumulates positional parameters for a single statement, rendering each
 *  placeholder with the active dialect (named `@pN` on SQL Server, `?` on MySQL). */
/** Whitelist of HAVING comparators — never interpolate the caller's operator. */
const HAVING_OPS: Record<string, string> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  eq: "=",
  ne: "<>",
};

/**
 * Turn a driver-level unique-index violation into the same `ConflictError` the
 * pre-write check produces.
 *
 * The check in `QueryEngine.assertUnique` is a courtesy: two concurrent creates
 * can both pass it and only one reach the index. Without this translation that
 * loser surfaced as a raw 500 — an internal error for what is a perfectly
 * ordinary "that value is taken".
 *
 * Both engines name the offending index in the message, and `ddl.ts` builds
 * unique index names as `UX_<table>_<column>`, so the field can be recovered
 * from it. When it cannot be, the error is re-thrown untouched rather than
 * guessed at.
 */
function asUniqueConflict(entity: string, error: unknown, resolver: MetadataResolver): unknown {
  const message = error instanceof Error ? error.message : String(error);
  const match = /UX_[A-Za-z0-9_]*?_([A-Za-z0-9_]+)/.exec(message);
  const fieldName = match?.[1];
  if (!fieldName) return error;
  const def = resolver.findEntity(entity);
  const field = def?.fields.find((f) => f.name === fieldName);
  if (!def || !field) return error;
  return new ConflictError(`${def.label} with ${field.label} already exists`, [
    { field: field.name, message: "must be unique" },
  ]).withKey("err.uniqueClashNoValue", { entity: def.name, field: field.name });
}

class Params {
  private readonly items: BoundParam[] = [];

  constructor(private readonly dialect: SqlDialect) {}

  /** Bind a value typed by its column descriptor; returns its placeholder. */
  col(col: ColumnDesc, value: unknown): string {
    return this.raw(sqlTypeForColumn(col), toStorage(col, value));
  }

  /** Bind a value with an explicit abstract type; returns its placeholder. */
  raw(type: SqlType, value: unknown): string {
    const ph = this.dialect.placeholder(this.items.length);
    this.items.push({ value, type });
    return ph;
  }

  get bound(): BoundParam[] {
    return this.items;
  }
}

export class SqlRepository implements Repository {
  private columnCache = new Map<string, ColumnDesc[]>();
  private columnMapCache = new Map<string, Map<string, ColumnDesc>>();
  private deps: { driver: SqlDriver; dialect: SqlDialect } | null = null;

  constructor(private readonly metadata: MetadataResolver) {}

  /** Resolve (and memoise) the active driver + dialect. */
  private async resolve(): Promise<{ driver: SqlDriver; dialect: SqlDialect }> {
    if (!this.deps) {
      const [driver, dialect] = await Promise.all([getDriver(), getDialect()]);
      this.deps = { driver, dialect };
    }
    return this.deps;
  }

  /**
   * Forget the memoised column shapes.
   *
   * The column list is derived from the metadata and cached for the life of the
   * process, which is right while the model is compiled in — and wrong the
   * moment a field can be added at runtime. Without this a published field
   * exists in the metadata, exists as a column in the database, and is still
   * absent from every SELECT and INSERT this repository builds: the value is
   * accepted, silently dropped, and reads back empty.
   */
  refreshSchema(): void {
    this.columnCache.clear();
    this.columnMapCache.clear();
  }

  private cols(entity: string): ColumnDesc[] {
    let cached = this.columnCache.get(entity);
    if (!cached) {
      cached = entityColumns(this.metadata.getEntity(entity));
      this.columnCache.set(entity, cached);
    }
    return cached;
  }

  private colMap(entity: string): Map<string, ColumnDesc> {
    let cached = this.columnMapCache.get(entity);
    if (!cached) {
      cached = new Map(this.cols(entity).map((c) => [c.name, c]));
      this.columnMapCache.set(entity, cached);
    }
    return cached;
  }

  private idCol(entity: string): ColumnDesc {
    return this.colMap(entity).get("id")!;
  }

  private selectList(entity: string, dialect: SqlDialect): string {
    return this.cols(entity)
      .map((c) => dialect.id(c.name))
      .join(", ");
  }

  private toRecord(entity: string, row: Record<string, unknown>): EntityRecord {
    const rec: Record<string, unknown> = {};
    for (const col of this.cols(entity)) {
      let v = row[col.name] ?? null;
      if (v !== null) {
        // id + reference columns are INT in the DB but strings in the app layer.
        if (isIdLike(col)) v = String(v);
        // BIT/TINYINT(1) comes back as a boolean (mssql) or 0/1 (mysql) — normalise.
        else if (col.kind === "bit") v = v === true || v === 1 || v === "1";
      }
      rec[col.name] = v;
    }
    return rec as EntityRecord;
  }

  private scopeClause(scope: TenantScope, p: Params, dialect: SqlDialect): string {
    const t = p.raw(T.string(80), scope.tenantId);
    const o = p.raw(T.string(80), scope.orgId);
    return `${dialect.id("tenantId")} = ${t} AND ${dialect.id("orgId")} = ${o}`;
  }

  private filterClause(entity: string, f: Filter, p: Params, dialect: SqlDialect): string | null {
    const col = this.colMap(entity).get(f.field);
    if (!col) return null;
    const c = dialect.id(f.field);
    switch (f.op) {
      case "eq":
        return f.value === null ? `${c} IS NULL` : `${c} = ${p.col(col, f.value)}`;
      case "ne":
        return f.value === null ? `${c} IS NOT NULL` : `(${c} <> ${p.col(col, f.value)} OR ${c} IS NULL)`;
      case "lt":
        return `${c} < ${p.col(col, f.value)}`;
      case "lte":
        return `${c} <= ${p.col(col, f.value)}`;
      case "gt":
        return `${c} > ${p.col(col, f.value)}`;
      case "gte":
        return `${c} >= ${p.col(col, f.value)}`;
      case "contains":
        return dialect.likeClause(c, p.raw(T.string(4000), `%${dialect.escapeLikePattern(String(f.value))}%`));
      case "in": {
        const arr = Array.isArray(f.value) ? f.value : [f.value];
        if (!arr.length) return "1 = 0";
        return `${c} IN (${arr.map((v) => p.col(col, v)).join(", ")})`;
      }
      default:
        return null;
    }
  }

  /**
   * "Strictly after this row", in the given ordering.
   *
   * Expanded by hand rather than written as a row-value comparison
   * (`(a,b) > (?,?)`): MySQL supports that only when every column ascends, and
   * SQL Server does not support it at all.
   *
   * NULLs are the part worth reading twice. Both engines sort NULL BELOW every
   * value — first when ascending, last when descending — and they agree, which
   * is what makes one expansion serve both. So:
   *
   *   ASC,  cursor value present → `col > v`; NULLs sort before v and are
   *                                already behind us.
   *   ASC,  cursor value NULL    → still inside the NULL run, or past it:
   *                                `col IS NOT NULL` handles "past".
   *   DESC, cursor value present → `col < v OR col IS NULL`, because the NULLs
   *                                are the tail of a descending sort.
   *   DESC, cursor value NULL    → the NULL run is last, so only the id breaks
   *                                the tie.
   *
   * Getting this wrong does not error. It silently skips rows or repeats them,
   * which on a reindex means records nobody can find and on an export means a
   * file that is quietly short.
   */
  private cursorClause(
    entity: string,
    sort: readonly Sort[],
    cursor: Cursor,
    p: Params,
    dialect: SqlDialect,
  ): string | null {
    const cols = this.colMap(entity);
    // `id` is appended as the final, always-non-null, always-unique tiebreaker —
    // the same one `list` adds to its ORDER BY.
    const keys = sort.map((s, i) => ({ field: s.field, dir: s.dir, value: cursor.values[i] ?? null }));
    for (const k of keys) if (!cols.get(k.field)) return null;

    const idCol = cols.get("id");
    if (!idCol) return null;

    const eq = (field: string, value: unknown): string => {
      const c = dialect.id(field);
      const col = cols.get(field);
      if (!col) return "1 = 0";
      return value === null ? `${c} IS NULL` : `${c} = ${p.col(col, value)}`;
    };

    const after = (field: string, dir: SortDirection, value: unknown): string => {
      const c = dialect.id(field);
      const col = cols.get(field);
      if (!col) return "1 = 0";
      if (dir === "desc") {
        return value === null ? "1 = 0" : `(${c} < ${p.col(col, value)} OR ${c} IS NULL)`;
      }
      return value === null ? `${c} IS NOT NULL` : `${c} > ${p.col(col, value)}`;
    };

    // OR of "equal on every earlier key AND strictly after on this one".
    const branches: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      const prefix = keys.slice(0, i).map((k) => eq(k.field, k.value));
      const k = keys[i];
      if (!k) continue;
      branches.push([...prefix, after(k.field, k.dir, k.value)].join(" AND "));
    }
    // The final branch: every sort key equal, so the id decides. It ascends
    // always, matching the ORDER BY, and is never null.
    const allEqual = keys.map((k) => eq(k.field, k.value));
    branches.push([...allEqual, `${dialect.id("id")} > ${p.col(idCol, cursor.id)}`].join(" AND "));

    return `(${branches.map((b) => `(${b})`).join(" OR ")})`;
  }

  private whereParts(entity: string, scope: TenantScope, filters: Filter[], p: Params, dialect: SqlDialect): string[] {
    const parts = [this.scopeClause(scope, p, dialect)];
    for (const f of filters) {
      const clause = this.filterClause(entity, f, p, dialect);
      if (clause) parts.push(clause);
    }
    return parts;
  }

  async list(scope: TenantScope, entity: string, query: RepoQuery): Promise<Page> {
    const { driver, dialect } = await this.resolve();
    const p = new Params(dialect);
    const parts = this.whereParts(entity, scope, query.filters, p, dialect);

    if (query.search && query.search.fields.length) {
      const term = `%${dialect.escapeLikePattern(query.search.term)}%`;
      // One placeholder per field so positional (`?`) binding stays correct.
      const ors = query.search.fields.map((f) => dialect.likeClause(dialect.id(f), p.raw(T.string(4000), term)));
      parts.push(`(${ors.join(" OR ")})`);
    }

    const order =
      query.sort.length > 0
        ? query.sort.map((s) => `${dialect.id(s.field)} ${s.dir === "desc" ? "DESC" : "ASC"}`).join(", ") +
          `, ${dialect.id("id")} ASC`
        : `${dialect.id("createdAt")} DESC, ${dialect.id("id")} ASC`;

    const pageClause = dialect.paginate(
      (value, type) => p.raw(type, value),
      (query.page - 1) * query.pageSize,
      query.pageSize,
    );
    const selectCols = this.selectList(entity, dialect);

    const text =
      `SELECT ${selectCols}, COUNT(*) OVER() AS ${dialect.id("__total")} FROM ${dialect.table(entity)} ` +
      `WHERE ${parts.join(" AND ")} ORDER BY ${order} ${pageClause}`;

    const result = await driver.query(text, p.bound);
    const rows = result.rows;
    // `COUNT(*) OVER()` rides along on every row, so the first row carries the
    // total; no rows means no total to read.
    const first = rows[0];
    const total = first ? Number(first.__total) : 0;
    const items = rows.map((r) => this.toRecord(entity, r));
    return {
      items,
      total,
      page: query.page,
      pageSize: query.pageSize,
      pageCount: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  /**
   * A page that resumes after a cursor, rather than after an offset.
   *
   * No `COUNT(*) OVER()`: producing a total means scanning the whole filtered
   * set on every page, which is most of what offset paging costs. A caller
   * walking a table does not need to be told how far there is to go on each
   * step, and one that does can ask `/aggregate` once.
   */
  async listAfter(
    scope: TenantScope,
    entity: string,
    query: RepoQuery,
    cursor: Cursor | null,
  ): Promise<{ items: EntityRecord[]; last: EntityRecord | null }> {
    const { driver, dialect } = await this.resolve();
    const p = new Params(dialect);
    const parts = this.whereParts(entity, scope, query.filters, p, dialect);

    if (query.search && query.search.fields.length) {
      const term = `%${dialect.escapeLikePattern(query.search.term)}%`;
      const ors = query.search.fields.map((f) => dialect.likeClause(dialect.id(f), p.raw(T.string(4000), term)));
      parts.push(`(${ors.join(" OR ")})`);
    }

    const sort: Sort[] = query.sort.length > 0 ? query.sort : [{ field: "createdAt", dir: "desc" }];
    if (cursor) {
      const clause = this.cursorClause(entity, sort, cursor, p, dialect);
      // An unusable cursor (a field that is not a column) must not silently
      // widen the query to the whole table — that would restart the walk from
      // the beginning and duplicate everything already delivered.
      if (!clause) throw new Error("cursor does not match this query's sort");
      parts.push(clause);
    }

    const order =
      sort.map((s) => `${dialect.id(s.field)} ${s.dir === "desc" ? "DESC" : "ASC"}`).join(", ") +
      `, ${dialect.id("id")} ASC`;

    // Offset is always zero: the cursor IS the offset, which is the point.
    const pageClause = dialect.paginate((value, type) => p.raw(type, value), 0, query.pageSize);
    const text =
      `SELECT ${this.selectList(entity, dialect)} FROM ${dialect.table(entity)} ` +
      `WHERE ${parts.join(" AND ")} ORDER BY ${order} ${pageClause}`;

    const result = await driver.query(text, p.bound);
    const items = result.rows.map((r) => this.toRecord(entity, r));
    return { items, last: items.length ? items[items.length - 1] ?? null : null };
  }

  async get(scope: TenantScope, entity: string, id: string): Promise<EntityRecord | null> {
    const { driver, dialect } = await this.resolve();
    const p = new Params(dialect);
    const idP = p.col(this.idCol(entity), id);
    const where = `${dialect.id("id")} = ${idP} AND ${this.scopeClause(scope, p, dialect)}`;
    const text = `SELECT ${this.selectList(entity, dialect)} FROM ${dialect.table(entity)} WHERE ${where}`;
    const result = await driver.query(text, p.bound);
    const row = result.rows[0];
    return row ? this.toRecord(entity, row) : null;
  }

  async getForUpdate(scope: TenantScope, entity: string, filters: Filter[]): Promise<EntityRecord | null> {
    const { driver, dialect } = await this.resolve();
    // Outside a transaction the engine releases the lock the moment the
    // statement returns, so the caller would get the *appearance* of
    // serialisation with none of the substance. Fail loudly instead.
    if (!driver.inTransaction()) {
      throw new ConflictError("getForUpdate must be called inside a transaction");
    }
    const p = new Params(dialect);
    // Same field whitelisting as `list` — filters go through `whereParts`, which
    // resolves each field against the entity's column map and drops unknowns.
    const parts = this.whereParts(entity, scope, filters, p, dialect);
    const text = dialect.lockingSelect(
      this.selectList(entity, dialect),
      dialect.table(entity),
      parts.join(" AND "),
    );
    const result = await driver.query(text, p.bound);
    const row = result.rows[0];
    return row ? this.toRecord(entity, row) : null;
  }

  async insert(entity: string, record: EntityRecord): Promise<EntityRecord> {
    const { driver, dialect } = await this.resolve();
    const table = dialect.table(entity);
    const p = new Params(dialect);
    const data = record as Record<string, unknown>;

    if (!record.id) {
      // Runtime create: let the DB assign the id, exclude it, read it back.
      const cols = this.cols(entity).filter((c) => !c.identity);
      const names = cols.map((c) => dialect.id(c.name)).join(", ");
      const values = cols.map((c) => p.col(c, data[c.name])).join(", ");
      const returning = dialect.returningId("id");
      const text = `INSERT INTO ${table} (${names}) ${returning ? returning + " " : ""}VALUES (${values})`;
      let result;
      try {
        result = await driver.query(text, p.bound);
      } catch (error) {
        if (driver.isUniqueViolation(error)) throw asUniqueConflict(entity, error, this.metadata);
        throw error;
      }
      const assigned =
        dialect.client === "mssql" ? (result.rows[0] as { id: unknown } | undefined)?.id : result.insertId;
      return { ...record, id: String(assigned) };
    }

    // Seeding with an explicit id: written directly into the auto-increment column.
    const cols = this.cols(entity);
    const names = cols.map((c) => dialect.id(c.name)).join(", ");
    const values = cols.map((c) => p.col(c, data[c.name])).join(", ");
    const insertStmt = `INSERT INTO ${table} (${names}) VALUES (${values})`;
    await driver.query(dialect.wrapIdentityInsert(table, insertStmt), p.bound);
    return record;
  }

  async bulkInsert(entity: string, records: EntityRecord[]): Promise<EntityRecord[]> {
    if (records.length === 0) return [];
    const { driver, dialect } = await this.resolve();
    const table = dialect.table(entity);
    // Runtime create: let the DB assign ids (same as insert's id-less path).
    const cols = this.cols(entity).filter((c) => !c.identity);
    const names = cols.map((c) => dialect.id(c.name)).join(", ");

    // SQL Server caps a request at 2100 parameters and an INSERT…VALUES at 1000
    // rows; MySQL is bounded by max_allowed_packet. chunkSize keeps params < 2100
    // and rows/statement ≤ 1000. The Math.max(1, …) only guards divide-by-zero.
    const perRow = Math.max(1, cols.length);
    const chunkSize = Math.max(1, Math.min(1000, Math.floor(2000 / perRow)));

    const out: EntityRecord[] = [];
    for (let i = 0; i < records.length; i += chunkSize) {
      const chunk = records.slice(i, i + chunkSize);
      const p = new Params(dialect);
      const tuples = chunk.map((rec) => {
        const data = rec as Record<string, unknown>;
        return `(${cols.map((c) => p.col(c, data[c.name])).join(", ")})`;
      });
      const returning = dialect.returningId("id");
      const text = `INSERT INTO ${table} (${names}) ${returning ? returning + " " : ""}VALUES ${tuples.join(", ")}`;
      const result = await driver.query(text, p.bound);

      let ids: unknown[];
      if (dialect.client === "mssql") {
        // OUTPUT row order is not guaranteed to match VALUES order, so callers
        // only rely on the created set/count, not id↔input alignment.
        ids = (result.rows as Array<{ id: unknown }>).map((r) => r.id);
      } else {
        // A multi-row "simple insert" assigns consecutive auto-increment ids
        // starting at insertId, in VALUES order.
        const first = Number(result.insertId ?? 0);
        ids = chunk.map((_, j) => first + j);
      }
      chunk.forEach((rec, j) => out.push({ ...rec, id: String(ids[j] ?? "") }));
    }
    return out;
  }

  async update(
    scope: TenantScope,
    entity: string,
    next: EntityRecord,
    expectedVersion?: number,
  ): Promise<EntityRecord> {
    const { driver, dialect } = await this.resolve();
    const cols = this.cols(entity).filter((c) => c.name !== "id");
    const p = new Params(dialect);
    const sets = cols
      .map((c) => `${dialect.id(c.name)} = ${p.col(c, (next as Record<string, unknown>)[c.name])}`)
      .join(", ");
    const idP = p.col(this.idCol(entity), next.id);
    let where = `${dialect.id("id")} = ${idP} AND ${this.scopeClause(scope, p, dialect)}`;
    if (expectedVersion !== undefined) {
      where += ` AND ${dialect.id("version")} = ${p.raw(T.int, expectedVersion)}`;
    }
    const text = `UPDATE ${dialect.table(entity)} SET ${sets} WHERE ${where}`;
    const result = await driver.query(text, p.bound);

    if (result.rowsAffected === 0) {
      const current = await this.get(scope, entity, next.id);
      if (!current) throw new ConflictError("record no longer exists");
      throw new ConflictError(
        `version conflict: expected ${expectedVersion} but found ${current.version}`,
      ).withKey("err.versionConflict", { expected: expectedVersion ?? 0, found: current.version ?? 0 });
    }
    return next;
  }

  async delete(scope: TenantScope, entity: string, id: string, expectedVersion?: number): Promise<void> {
    const { driver, dialect } = await this.resolve();
    const p = new Params(dialect);
    const idP = p.col(this.idCol(entity), id);
    let where = `${dialect.id("id")} = ${idP} AND ${this.scopeClause(scope, p, dialect)}`;
    if (expectedVersion !== undefined) {
      where += ` AND ${dialect.id("version")} = ${p.raw(T.int, expectedVersion)}`;
    }
    const text = `DELETE FROM ${dialect.table(entity)} WHERE ${where}`;
    const result = await driver.query(text, p.bound);

    if (result.rowsAffected === 0 && expectedVersion !== undefined) {
      const current = await this.get(scope, entity, id);
      if (current) throw new ConflictError(`version conflict on delete of ${entity} ${id}`).withKey("err.versionConflictDelete", { entity, id });
    }
  }

  async updateMany(scope: TenantScope, entity: string, ids: string[], patch: Record<string, unknown>): Promise<number> {
    if (ids.length === 0) return 0;
    const { driver, dialect } = await this.resolve();
    const colMap = this.colMap(entity);
    const p = new Params(dialect);
    const sets: string[] = [];
    for (const [field, value] of Object.entries(patch)) {
      const col = colMap.get(field);
      if (!col || col.name === "id" || col.name === "version") continue;
      sets.push(`${dialect.id(col.name)} = ${p.col(col, value)}`);
    }
    if (sets.length === 0) return 0;
    sets.push(`${dialect.id("version")} = ${dialect.id("version")} + 1`);
    const idCol = this.idCol(entity);
    const inList = ids.map((id) => p.col(idCol, id)).join(", ");
    const where = `${dialect.id("id")} IN (${inList}) AND ${this.scopeClause(scope, p, dialect)}`;
    const text = `UPDATE ${dialect.table(entity)} SET ${sets.join(", ")} WHERE ${where}`;
    const result = await driver.query(text, p.bound);
    return result.rowsAffected;
  }

  async deleteMany(scope: TenantScope, entity: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const { driver, dialect } = await this.resolve();
    const p = new Params(dialect);
    const idCol = this.idCol(entity);
    const inList = ids.map((id) => p.col(idCol, id)).join(", ");
    const where = `${dialect.id("id")} IN (${inList}) AND ${this.scopeClause(scope, p, dialect)}`;
    const text = `DELETE FROM ${dialect.table(entity)} WHERE ${where}`;
    const result = await driver.query(text, p.bound);
    return result.rowsAffected;
  }

  async existsByField(
    scope: TenantScope,
    entity: string,
    field: string,
    value: unknown,
    exceptId?: string,
  ): Promise<boolean> {
    if (value === null || value === undefined) return false;
    const col = this.colMap(entity).get(field);
    if (!col) return false;
    const { driver, dialect } = await this.resolve();
    const p = new Params(dialect);
    let where = `${this.scopeClause(scope, p, dialect)} AND ${dialect.id(field)} = ${p.col(col, value)}`;
    if (exceptId !== undefined) {
      where += ` AND ${dialect.id("id")} <> ${p.col(this.idCol(entity), exceptId)}`;
    }
    const text = dialect.existsSelect(`FROM ${dialect.table(entity)} WHERE ${where}`);
    const result = await driver.query(text, p.bound);
    return result.rows.length > 0;
  }

  async aggregate(scope: TenantScope, entity: string, query: AggregateQuery): Promise<AggregateRow[]> {
    const { driver, dialect } = await this.resolve();
    const colMap = this.colMap(entity);
    const q = normalizeAggregate(query);
    const p = new Params(dialect);
    const parts = this.whereParts(entity, scope, q.filters, p, dialect);

    // Injection surface: the only caller-controlled strings that reach SQL text
    // are field names, and every one is checked against `colMap` before being
    // quoted. Aliases are positional (`__k0`), never user text.
    const selects: string[] = [];
    const dimExprs: string[] = [];
    for (const [i, d] of q.dimensions.entries()) {
      if (!colMap.has(d.field)) {
        throw new BadRequestError(`cannot group by unknown field "${d.field}"`);
      }
      const col = dialect.id(d.field);
      const expr = d.bucket ? dialect.dateBucketExpr(col, d.bucket) : col;
      dimExprs.push(expr);
      selects.push(`${expr} AS ${dialect.id(`__k${i}`)}`);
    }

    const measureExpr = new Map<string, string>();
    for (const m of q.measures) {
      // A free-form alias reaches `dialect.id`, which escapes the quote char so
      // it cannot break out — but "a b", a 500-char alias or one colliding with
      // `__k0` still produces confusing SQL. Keep it to plain identifiers.
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(m.as)) {
        throw new BadRequestError(`invalid measure alias "${m.as}"`);
      }
      const alias = dialect.id(m.as);
      if (m.op === "count") {
        const expr = "COUNT(*)";
        measureExpr.set(m.as, expr);
        selects.push(`${expr} AS ${alias}`);
        continue;
      }
      if (!m.field || !colMap.has(m.field)) {
        throw new BadRequestError(`aggregate measure "${m.as}" references unknown field`);
      }
      const f = dialect.id(m.field);
      const expr =
        m.op === "sum" ? `COALESCE(SUM(${f}), 0)`
        : m.op === "avg" ? `COALESCE(${dialect.avgExpr(f)}, 0)`
        : m.op === "min" ? `COALESCE(MIN(${f}), 0)`
        : m.op === "max" ? `COALESCE(MAX(${f}), 0)`
        : dialect.countDistinctExpr(f);
      measureExpr.set(m.as, expr);
      selects.push(`${expr} AS ${alias}`);
    }
    if (selects.length === 0) throw new BadRequestError("aggregate requires at least one measure");

    let text = `SELECT ${selects.join(", ")} FROM ${dialect.table(entity)} WHERE ${parts.join(" AND ")}`;
    // Group by the *expressions*: neither engine portably groups by a SELECT alias.
    if (dimExprs.length) text += ` GROUP BY ${dimExprs.join(", ")}`;

    for (const [i, h] of q.having.entries()) {
      const expr = measureExpr.get(h.measure);
      if (!expr) throw new BadRequestError(`having references unknown measure "${h.measure}"`);
      const op = HAVING_OPS[h.op];
      if (!op) throw new BadRequestError(`unsupported having operator "${h.op}"`);
      text += `${i === 0 ? " HAVING " : " AND "}${expr} ${op} ${p.raw(T.decimal(18, 4), h.value)}`;
    }

    if (q.sort.length) {
      const order = q.sort.map((s) => {
        const dimIndex = q.dimensions.findIndex((d) => d.as === s.by || d.field === s.by);
        const expr = dimIndex >= 0 ? dimExprs[dimIndex] : measureExpr.get(s.by);
        if (!expr) throw new BadRequestError(`cannot sort by unknown key "${s.by}"`);
        return `${expr} ${s.dir === "desc" ? "DESC" : "ASC"}`;
      });
      text += ` ORDER BY ${order.join(", ")}`;
    } else if (dimExprs.length) {
      // A LIMIT without an ordering is arbitrary, and MSSQL's OFFSET/FETCH
      // requires an ORDER BY at all. Bucket keys sort correctly as strings.
      text += ` ORDER BY ${dimExprs.join(", ")}`;
    }

    // Read one extra row purely to detect truncation, then drop it. Silently
    // returning a short result is the page-size clamp bug in another costume.
    if (dimExprs.length) {
      text += ` ${dialect.paginate((value, type) => p.raw(type, value), 0, q.limit + 1)}`;
    }

    const result = await driver.query(text, p.bound);
    const rows = result.rows.slice(0, q.limit);
    if (result.rows.length > q.limit) {
      logger.warn("aggregate result truncated", { entity, limit: q.limit, dimensions: q.dimensions.length });
    }
    return rows.map((row) => {
      const measures: Record<string, number> = {};
      for (const m of q.measures) measures[m.as] = Number(row[m.as] ?? 0);
      const keys: Record<string, string | null> = {};
      for (const [i, d] of q.dimensions.entries()) {
        const raw = row[`__k${i}`];
        keys[d.as] = raw === null || raw === undefined ? "" : String(raw);
      }
      const first = q.dimensions[0];
      return { key: first ? keys[first.as] ?? null : null, keys, measures };
    });
  }

  /** System-level scan across every entity table (used for search reindex). */
  async scanAll(): Promise<{ entity: string; record: EntityRecord }[]> {
    const { driver, dialect } = await this.resolve();
    const entities = this.metadata.listEntities();
    const lanes = Math.max(2, (driver.poolMax || 8) - 1);
    const results: { entity: string; record: EntityRecord }[][] = new Array(entities.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor++;
        // Reading the entity IS the bounds check — see the same shape in
        // `migrate.ts`.
        const entity = entities[i];
        if (entity === undefined) return;
        const selectCols = this.selectList(entity.name, dialect);
        const result = await driver.query(`SELECT ${selectCols} FROM ${dialect.table(entity.name)}`, []);
        results[i] = result.rows.map((row) => ({
          entity: entity.name,
          record: this.toRecord(entity.name, row),
        }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(lanes, entities.length) }, () => worker()));
    return results.flat();
  }

  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const { driver } = await this.resolve();
    return driver.transaction(fn);
  }
}
