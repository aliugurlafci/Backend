/**
 * MSSQL repository adapter.
 *
 * Implements the tenant-scoped `Repository` contract against SQL Server using
 * fully parameterized queries (no string interpolation of values — injection
 * safe). All enforcement (permissions, validation, isolation rules) lives above
 * this in the query engine; this adapter just translates the query language to
 * WHERE / ORDER BY / OFFSET-FETCH / GROUP BY and maps optimistic concurrency to
 * version-guarded UPDATE/DELETE.
 */
import { BadRequestError, ConflictError } from "@/lib/enforcement/errors";
import type { EntityRecord } from "@/lib/metadata/types";
import type { MetadataResolver } from "@/lib/metadata/resolver";
import type { TenantScope } from "@/lib/context/types";
import type { Repository } from "../repository";
import type { AggregateQuery, AggregateRow, Filter, Page, RepoQuery } from "../query";
import { getPool, sql } from "./connection";
import {
  entityColumns,
  ident,
  isIdLike,
  sqlTypeFor,
  tableName,
  toStorage,
  type ColumnDesc,
} from "./schema-map";

interface Bound {
  name: string;
  type: sql.ISqlType;
  value: unknown;
}

/** Accumulates positional parameters for a single statement. */
class Params {
  private i = 0;
  readonly list: Bound[] = [];

  /** Bind a value typed by its column descriptor; returns the @placeholder. */
  col(col: ColumnDesc, value: unknown): string {
    return this.raw(sqlTypeFor(col), toStorage(col, value));
  }

  /** Bind a value with an explicit SQL type. */
  raw(type: sql.ISqlType, value: unknown): string {
    const name = `p${this.i++}`;
    this.list.push({ name, type, value });
    return `@${name}`;
  }

  apply(req: sql.Request): sql.Request {
    for (const b of this.list) req.input(b.name, b.type, b.value);
    return req;
  }
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_[]/g, (ch) => `\\${ch}`);
}

function nvarchar(len: number): sql.ISqlType {
  return sql.NVarChar(len) as unknown as sql.ISqlType;
}

export class MssqlRepository implements Repository {
  private columnCache = new Map<string, ColumnDesc[]>();
  private columnMapCache = new Map<string, Map<string, ColumnDesc>>();

  constructor(private readonly metadata: MetadataResolver) {}

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

  private async request(): Promise<sql.Request> {
    return (await getPool()).request();
  }

  private scopeClause(scope: TenantScope, p: Params): string {
    const t = p.raw(nvarchar(80), scope.tenantId);
    const o = p.raw(nvarchar(80), scope.orgId);
    return `${ident("tenantId")} = ${t} AND ${ident("orgId")} = ${o}`;
  }

  private filterClause(entity: string, f: Filter, p: Params): string | null {
    const col = this.colMap(entity).get(f.field);
    if (!col) return null;
    const c = ident(f.field);
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
        return `${c} LIKE ${p.raw(nvarchar(4000), `%${escapeLike(String(f.value))}%`)} ESCAPE '\\'`;
      case "in": {
        const arr = Array.isArray(f.value) ? f.value : [f.value];
        if (!arr.length) return "1 = 0";
        return `${c} IN (${arr.map((v) => p.col(col, v)).join(", ")})`;
      }
      default:
        return null;
    }
  }

  private whereParts(entity: string, scope: TenantScope, filters: Filter[], p: Params): string[] {
    const parts = [this.scopeClause(scope, p)];
    for (const f of filters) {
      const clause = this.filterClause(entity, f, p);
      if (clause) parts.push(clause);
    }
    return parts;
  }

  private toRecord(entity: string, row: Record<string, unknown>): EntityRecord {
    const rec: Record<string, unknown> = {};
    for (const col of this.cols(entity)) {
      const v = row[col.name] ?? null;
      // id + reference columns are INT in the DB but strings in the app layer.
      rec[col.name] = v !== null && isIdLike(col) ? String(v) : v;
    }
    return rec as EntityRecord;
  }

  private idCol(entity: string): ColumnDesc {
    return this.colMap(entity).get("id")!;
  }

  async list(scope: TenantScope, entity: string, query: RepoQuery): Promise<Page> {
    const p = new Params();
    const parts = this.whereParts(entity, scope, query.filters, p);

    if (query.search && query.search.fields.length) {
      const like = p.raw(nvarchar(4000), `%${escapeLike(query.search.term)}%`);
      const ors = query.search.fields.map((f) => `${ident(f)} LIKE ${like} ESCAPE '\\'`);
      parts.push(`(${ors.join(" OR ")})`);
    }

    const order =
      query.sort.length > 0
        ? query.sort.map((s) => `${ident(s.field)} ${s.dir === "desc" ? "DESC" : "ASC"}`).join(", ") +
          `, ${ident("id")} ASC`
        : `${ident("createdAt")} DESC, ${ident("id")} ASC`;

    const offset = p.raw(sql.Int() as unknown as sql.ISqlType, (query.page - 1) * query.pageSize);
    const limit = p.raw(sql.Int() as unknown as sql.ISqlType, query.pageSize);
    const selectCols = this.cols(entity).map((c) => ident(c.name)).join(", ");

    const text =
      `SELECT ${selectCols}, COUNT(*) OVER() AS [__total] FROM ${tableName(entity)} ` +
      `WHERE ${parts.join(" AND ")} ORDER BY ${order} ` +
      `OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;

    const result = await p.apply(await this.request()).query(text);
    const rows = result.recordset as Array<Record<string, unknown>>;
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
    const p = new Params();
    const idP = p.col(this.idCol(entity), id);
    const where = `${ident("id")} = ${idP} AND ${this.scopeClause(scope, p)}`;
    const selectCols = this.cols(entity).map((c) => ident(c.name)).join(", ");
    const text = `SELECT ${selectCols} FROM ${tableName(entity)} WHERE ${where}`;
    const result = await p.apply(await this.request()).query(text);
    const row = (result.recordset as Array<Record<string, unknown>>)[0];
    return row ? this.toRecord(entity, row) : null;
  }

  async insert(entity: string, record: EntityRecord): Promise<EntityRecord> {
    const t = tableName(entity);
    const p = new Params();
    const data = record as Record<string, unknown>;

    if (!record.id) {
      // Runtime create: let IDENTITY assign the id, exclude it, read it back.
      const cols = this.cols(entity).filter((c) => !c.identity);
      const names = cols.map((c) => ident(c.name)).join(", ");
      const values = cols.map((c) => p.col(c, data[c.name])).join(", ");
      const text =
        `INSERT INTO ${t} (${names}) OUTPUT INSERTED.${ident("id")} AS [id] VALUES (${values})`;
      const result = await p.apply(await this.request()).query(text);
      const assigned = (result.recordset as Array<{ id: unknown }>)[0]?.id;
      return { ...record, id: String(assigned) };
    }

    // Seeding with an explicit id: IDENTITY_INSERT lets us write the id column.
    const cols = this.cols(entity);
    const names = cols.map((c) => ident(c.name)).join(", ");
    const values = cols.map((c) => p.col(c, data[c.name])).join(", ");
    const text =
      `SET IDENTITY_INSERT ${t} ON; ` +
      `INSERT INTO ${t} (${names}) VALUES (${values}); ` +
      `SET IDENTITY_INSERT ${t} OFF;`;
    await p.apply(await this.request()).query(text);
    return record;
  }

  async update(
    scope: TenantScope,
    entity: string,
    next: EntityRecord,
    expectedVersion?: number,
  ): Promise<EntityRecord> {
    const cols = this.cols(entity).filter((c) => c.name !== "id");
    const p = new Params();
    const sets = cols
      .map((c) => `${ident(c.name)} = ${p.col(c, (next as Record<string, unknown>)[c.name])}`)
      .join(", ");
    const idP = p.col(this.idCol(entity), next.id);
    let where = `${ident("id")} = ${idP} AND ${this.scopeClause(scope, p)}`;
    if (expectedVersion !== undefined) {
      where += ` AND ${ident("version")} = ${p.raw(sql.Int() as unknown as sql.ISqlType, expectedVersion)}`;
    }
    const text = `UPDATE ${tableName(entity)} SET ${sets} WHERE ${where}`;
    const result = await p.apply(await this.request()).query(text);

    if ((result.rowsAffected[0] ?? 0) === 0) {
      const current = await this.get(scope, entity, next.id);
      if (!current) throw new ConflictError("record no longer exists");
      throw new ConflictError(
        `version conflict: expected ${expectedVersion} but found ${current.version}`,
      );
    }
    return next;
  }

  async delete(scope: TenantScope, entity: string, id: string, expectedVersion?: number): Promise<void> {
    const p = new Params();
    const idP = p.col(this.idCol(entity), id);
    let where = `${ident("id")} = ${idP} AND ${this.scopeClause(scope, p)}`;
    if (expectedVersion !== undefined) {
      where += ` AND ${ident("version")} = ${p.raw(sql.Int() as unknown as sql.ISqlType, expectedVersion)}`;
    }
    const text = `DELETE FROM ${tableName(entity)} WHERE ${where}`;
    const result = await p.apply(await this.request()).query(text);

    if ((result.rowsAffected[0] ?? 0) === 0 && expectedVersion !== undefined) {
      const current = await this.get(scope, entity, id);
      if (current) throw new ConflictError(`version conflict on delete of ${entity} ${id}`);
    }
  }

  async updateMany(scope: TenantScope, entity: string, ids: string[], patch: Record<string, unknown>): Promise<number> {
    if (ids.length === 0) return 0;
    const colMap = this.colMap(entity);
    const p = new Params();
    const sets: string[] = [];
    for (const [field, value] of Object.entries(patch)) {
      const col = colMap.get(field);
      if (!col || col.name === "id" || col.name === "version") continue;
      sets.push(`${ident(col.name)} = ${p.col(col, value)}`);
    }
    if (sets.length === 0) return 0;
    sets.push(`${ident("version")} = ${ident("version")} + 1`);
    const idCol = this.idCol(entity);
    const inList = ids.map((id) => p.col(idCol, id)).join(", ");
    const where = `${ident("id")} IN (${inList}) AND ${this.scopeClause(scope, p)}`;
    const text = `UPDATE ${tableName(entity)} SET ${sets.join(", ")} WHERE ${where}`;
    const result = await p.apply(await this.request()).query(text);
    return result.rowsAffected[0] ?? 0;
  }

  async deleteMany(scope: TenantScope, entity: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const p = new Params();
    const idCol = this.idCol(entity);
    const inList = ids.map((id) => p.col(idCol, id)).join(", ");
    const where = `${ident("id")} IN (${inList}) AND ${this.scopeClause(scope, p)}`;
    const text = `DELETE FROM ${tableName(entity)} WHERE ${where}`;
    const result = await p.apply(await this.request()).query(text);
    return result.rowsAffected[0] ?? 0;
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
    const p = new Params();
    let where = `${this.scopeClause(scope, p)} AND ${ident(field)} = ${p.col(col, value)}`;
    if (exceptId !== undefined) {
      where += ` AND ${ident("id")} <> ${p.col(this.idCol(entity), exceptId)}`;
    }
    const text = `SELECT TOP 1 1 AS x FROM ${tableName(entity)} WHERE ${where}`;
    const result = await p.apply(await this.request()).query(text);
    return (result.recordset as unknown[]).length > 0;
  }

  async aggregate(scope: TenantScope, entity: string, query: AggregateQuery): Promise<AggregateRow[]> {
    const colMap = this.colMap(entity);
    const p = new Params();
    const parts = this.whereParts(entity, scope, query.filters ?? [], p);

    if (query.groupBy && !colMap.has(query.groupBy)) {
      throw new BadRequestError(`cannot group by unknown field "${query.groupBy}"`);
    }

    const selects: string[] = [];
    if (query.groupBy) selects.push(`${ident(query.groupBy)} AS [__key]`);

    for (const m of query.measures) {
      const alias = ident(m.as);
      if (m.op === "count") {
        selects.push(`COUNT(*) AS ${alias}`);
        continue;
      }
      if (!m.field || !colMap.has(m.field)) {
        throw new BadRequestError(`aggregate measure "${m.as}" references unknown field`);
      }
      const f = ident(m.field);
      if (m.op === "sum") selects.push(`COALESCE(SUM(${f}), 0) AS ${alias}`);
      else if (m.op === "avg") selects.push(`COALESCE(AVG(CAST(${f} AS FLOAT)), 0) AS ${alias}`);
      else if (m.op === "min") selects.push(`COALESCE(MIN(${f}), 0) AS ${alias}`);
      else if (m.op === "max") selects.push(`COALESCE(MAX(${f}), 0) AS ${alias}`);
    }

    let text = `SELECT ${selects.join(", ")} FROM ${tableName(entity)} WHERE ${parts.join(" AND ")}`;
    if (query.groupBy) text += ` GROUP BY ${ident(query.groupBy)}`;

    const result = await p.apply(await this.request()).query(text);
    const rows = result.recordset as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const measures: Record<string, number> = {};
      for (const m of query.measures) measures[m.as] = Number(row[m.as] ?? 0);
      const key = query.groupBy ? (row.__key === null || row.__key === undefined ? "" : String(row.__key)) : null;
      return { key, measures };
    });
  }

  /** System-level scan across every entity table (used for search reindex). */
  async scanAll(): Promise<{ entity: string; record: EntityRecord }[]> {
    const out: { entity: string; record: EntityRecord }[] = [];
    for (const entity of this.metadata.listEntities()) {
      const selectCols = this.cols(entity.name).map((c) => ident(c.name)).join(", ");
      const result = await (await this.request()).query(`SELECT ${selectCols} FROM ${tableName(entity.name)}`);
      for (const row of result.recordset as Array<Record<string, unknown>>) {
        out.push({ entity: entity.name, record: this.toRecord(entity.name, row) });
      }
    }
    return out;
  }
}
