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
import type { EntityRecord } from "@/lib/metadata/types";
import type { MetadataResolver } from "@/lib/metadata/resolver";
import type { TenantScope } from "@/lib/context/types";
import type { Repository } from "../repository";
import type { AggregateQuery, AggregateRow, Filter, Page, RepoQuery } from "../query";
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
    const total = rows.length > 0 ? Number(rows[0].__total) : 0;
    const items = rows.map((r) => this.toRecord(entity, r));
    return {
      items,
      total,
      page: query.page,
      pageSize: query.pageSize,
      pageCount: Math.max(1, Math.ceil(total / query.pageSize)),
    };
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
      const result = await driver.query(text, p.bound);
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
      );
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
      if (current) throw new ConflictError(`version conflict on delete of ${entity} ${id}`);
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
    const p = new Params(dialect);
    const parts = this.whereParts(entity, scope, query.filters ?? [], p, dialect);

    if (query.groupBy && !colMap.has(query.groupBy)) {
      throw new BadRequestError(`cannot group by unknown field "${query.groupBy}"`);
    }

    const selects: string[] = [];
    if (query.groupBy) selects.push(`${dialect.id(query.groupBy)} AS ${dialect.id("__key")}`);

    for (const m of query.measures) {
      const alias = dialect.id(m.as);
      if (m.op === "count") {
        selects.push(`COUNT(*) AS ${alias}`);
        continue;
      }
      if (!m.field || !colMap.has(m.field)) {
        throw new BadRequestError(`aggregate measure "${m.as}" references unknown field`);
      }
      const f = dialect.id(m.field);
      if (m.op === "sum") selects.push(`COALESCE(SUM(${f}), 0) AS ${alias}`);
      else if (m.op === "avg") selects.push(`COALESCE(${dialect.avgExpr(f)}, 0) AS ${alias}`);
      else if (m.op === "min") selects.push(`COALESCE(MIN(${f}), 0) AS ${alias}`);
      else if (m.op === "max") selects.push(`COALESCE(MAX(${f}), 0) AS ${alias}`);
    }

    let text = `SELECT ${selects.join(", ")} FROM ${dialect.table(entity)} WHERE ${parts.join(" AND ")}`;
    if (query.groupBy) text += ` GROUP BY ${dialect.id(query.groupBy)}`;

    const result = await driver.query(text, p.bound);
    return result.rows.map((row) => {
      const measures: Record<string, number> = {};
      for (const m of query.measures) measures[m.as] = Number(row[m.as] ?? 0);
      const key = query.groupBy ? (row.__key === null || row.__key === undefined ? "" : String(row.__key)) : null;
      return { key, measures };
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
        if (i >= entities.length) return;
        const entity = entities[i];
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
