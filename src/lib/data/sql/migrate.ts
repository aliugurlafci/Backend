/**
 * Schema migration + self-healing reconcile — the single place that provisions
 * the physical schema (SQL Server or MySQL) from the metadata entity definitions.
 *
 * Two modes, chosen automatically:
 *
 *  1. Full provision (first boot, or after a `SCHEMA_VERSION` bump): create every
 *     table, add any missing column, run the complete index + foreign-key sweep,
 *     then record the version so it runs once. Bump the version when you change
 *     something the cheap reconcile can't see (a new index/FK on an existing table).
 *
 *  2. Reconcile (every other boot): introspect the live schema in one query and
 *     emit DDL only for genuine differences — create a new entity's table (+ its
 *     indexes/FKs) and add a new field's column (+ its index). Adding an
 *     entity/field "just works" on the next boot with no version bump.
 *
 * Every statement is idempotent (self-guarded on SQL Server; run tolerantly of
 * "already exists" on MySQL), so both modes are safe to re-run. Provisioning is
 * entity-parallel (bounded by the pool).
 */
import type { EntityDef } from "@/lib/metadata/types";
import { metadata } from "@/lib/metadata";
import { systemClock } from "@/lib/core/clock";
import { logger } from "@/lib/observability/logger";
import { delay, getDriver, MAX_DEADLOCK_RETRIES, retryBackoff, type SqlDriver } from "./driver";
import { getDialect, type SqlDialect } from "./dialect";
import { entityColumns } from "./schema-map";
import { T } from "./types";
import {
  createTableStatement,
  indexStatements,
  columnIndexStatements,
  allForeignKeyStatements,
  supportStatements,
  missingColumnStatements,
} from "./ddl";

// Bump this whenever a schema change can't be picked up by the cheap reconcile —
// i.e. a new index or foreign key on an EXISTING table. New entities and new
// nullable fields are applied automatically by the reconcile without a bump.
// v3: currency columns DECIMAL(18,2) + foreign-key constraints.
// v4: `mobileScreenConfig` entity (mobile screen-visibility layer).
// v5: `stockBalance` (maintained on-hand + value, with a unique index on
//     stockKey) and `journalLine.entryDate`. The bump is for the unique index —
//     the reconcile adds new tables and nullable columns, but not indexes on an
//     existing one — and it also marks a behavioural break: costing moved from
//     `product.costPrice` to a perpetual moving average, so historical stock
//     values written under the old scheme are not comparable and cannot be
//     migrated. Rebuild the database rather than backfill; see the note in
//     lib/inventory/costing.
const SCHEMA_VERSION = 5;

/** Run `fn` over `items` with at most `concurrency` in flight. Rejects on first error. */
async function mapPool<T>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      // Reading the item IS the bounds check. `i >= items.length` told the
      // human but not the compiler, which cannot carry a comparison on `i`
      // across the increment that produced it.
      const item = items[i];
      if (item === undefined) return;
      await fn(item, i);
    }
  };
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
}

/** Concurrency for provisioning: a lane below the pool max, never below 2. */
function ddlConcurrency(driver: SqlDriver): number {
  return Math.max(2, (driver.poolMax || 8) - 1);
}

/**
 * Execute a DDL statement, swallowing "already exists" (idempotent re-run) and
 * retrying a deadlock.
 *
 * Provisioning runs several statements at once, and concurrent DDL contends on
 * the engine's data dictionary — MySQL will pick one as a deadlock victim. That
 * is transient and the statement is idempotent, so retrying is correct; letting
 * it escape aborted the whole boot and made a schema-version bump a coin flip.
 *
 * The DML path already treats deadlocks this way (`MAX_DEADLOCK_RETRIES` in the
 * drivers); this brings DDL in line.
 */
async function execTolerant(driver: SqlDriver, stmt: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await driver.exec(stmt);
      return;
    } catch (e) {
      if (driver.isAlreadyExists(e)) return;
      if (driver.isDeadlock(e) && attempt < MAX_DEADLOCK_RETRIES) {
        await delay(retryBackoff(attempt));
        continue;
      }
      throw e;
    }
  }
}

/** Has this schema version already been fully provisioned? */
async function isVersionApplied(driver: SqlDriver, dialect: SqlDialect): Promise<boolean> {
  const res = await driver.query(
    `SELECT 1 AS ok FROM ${dialect.table("_schema_migrations")} WHERE ${dialect.id("version")} = ${dialect.placeholder(0)}`,
    [{ value: SCHEMA_VERSION, type: T.int }],
  );
  return res.rows.length > 0;
}

/** Record the current schema version so the full provision runs exactly once. */
async function recordVersion(driver: SqlDriver, dialect: SqlDialect): Promise<void> {
  const t = dialect.table("_schema_migrations");
  const v = dialect.id("version");
  const a = dialect.id("appliedAt");
  const p0 = dialect.placeholder(0);
  const p1 = dialect.placeholder(1);
  const params = [
    { value: SCHEMA_VERSION, type: T.int },
    { value: systemClock.isoNow(), type: T.string(40) },
  ];
  if (dialect.client === "mysql") {
    await driver.query(`INSERT IGNORE INTO ${t} (${v}, ${a}) VALUES (${p0}, ${p1})`, params);
  } else {
    await driver.query(
      `IF NOT EXISTS (SELECT 1 FROM ${t} WHERE ${v} = ${p0}) INSERT INTO ${t} (${v}, ${a}) VALUES (${p0}, ${p1})`,
      params,
    );
  }
}

/** One query → the live set of tables and each table's columns. */
async function introspectSchema(
  driver: SqlDriver,
  dialect: SqlDialect,
): Promise<{ tables: Set<string>; columns: Map<string, Set<string>> }> {
  const tables = new Set<string>();
  const columns = new Map<string, Set<string>>();
  const res = await driver.query(dialect.introspectSql(), []);
  for (const row of res.rows as Array<{ tbl: string; col: string }>) {
    tables.add(row.tbl);
    let set = columns.get(row.tbl);
    if (!set) {
      set = new Set<string>();
      columns.set(row.tbl, set);
    }
    set.add(row.col);
  }
  return { tables, columns };
}

/** Tolerant FK pass — a single FK failure is logged, never blocks provisioning. */
async function provisionForeignKeys(
  driver: SqlDriver,
  dialect: SqlDialect,
  entities: EntityDef[],
  concurrency: number,
): Promise<void> {
  const fkStatements = allForeignKeyStatements(entities, dialect);
  let ok = 0;
  await mapPool(fkStatements, concurrency, async (stmt) => {
    try {
      // Through `execTolerant`, so a deadlock from concurrent ALTERs is retried
      // rather than logged as "skipped" — a skipped FK is a missing referential
      // guarantee that nothing afterwards mentions again.
      await execTolerant(driver, stmt);
      ok++;
    } catch (e) {
      if (driver.isAlreadyExists(e)) {
        ok++;
        return;
      }
      logger.warn("foreign-key statement skipped", { error: String(e), stmt });
    }
  });
  logger.info("foreign keys provisioned", { ok, total: fkStatements.length });
}

export async function runMigrations(): Promise<void> {
  const driver = await getDriver();
  const dialect = await getDialect();

  // Create the target database first if it doesn't exist yet.
  await driver.ensureDatabase();

  // Support tables (schema-version ledger, sequence counters, file blobs) — cheap
  // + idempotent, and needed before we can read the ledger.
  for (const stmt of supportStatements(dialect)) await execTolerant(driver, stmt);

  const entities = metadata.listEntities();
  const concurrency = ddlConcurrency(driver);
  const versioned = await isVersionApplied(driver, dialect);
  const { tables, columns } = await introspectSchema(driver, dialect);

  if (!versioned) {
    // First boot for this version: create tables, add missing columns, then the
    // full index sweep, then FKs, then record the version so this pass runs once.
    logger.info("provisioning schema (full)", {
      version: SCHEMA_VERSION,
      client: dialect.client,
      entities: entities.length,
      concurrency,
    });
    await mapPool(entities, concurrency, async (entity) => {
      if (!tables.has(entity.name)) {
        await execTolerant(driver, createTableStatement(entity, dialect));
      } else {
        const existing = columns.get(entity.name) ?? new Set<string>();
        for (const stmt of missingColumnStatements(entity, existing, dialect)) {
          await execTolerant(driver, stmt);
        }
      }
      for (const stmt of indexStatements(entity, dialect)) await execTolerant(driver, stmt);
    });
    await provisionForeignKeys(driver, dialect, entities, concurrency);
    await recordVersion(driver, dialect);
    logger.info("schema migration complete", { version: SCHEMA_VERSION, entities: entities.length });
    return;
  }

  // Already provisioned: cheap self-healing reconcile. Create any new table (+ its
  // indexes/FKs) and add any missing nullable column (+ index a new indexed field).
  const missingTables = entities.filter((e) => !tables.has(e.name));
  let createdTables = 0;
  let addedColumns = 0;
  await mapPool(entities, concurrency, async (entity) => {
    if (!tables.has(entity.name)) {
      await execTolerant(driver, createTableStatement(entity, dialect));
      for (const stmt of indexStatements(entity, dialect)) await execTolerant(driver, stmt);
      createdTables++;
      return;
    }
    const existing = columns.get(entity.name) ?? new Set<string>();
    const added = entityColumns(entity)
      .filter((c) => !c.notNull && !existing.has(c.name))
      .map((c) => c.name);
    if (added.length === 0) return;
    for (const stmt of missingColumnStatements(entity, existing, dialect)) {
      await execTolerant(driver, stmt);
      addedColumns++;
    }
    for (const stmt of columnIndexStatements(entity, dialect, new Set(added))) {
      await execTolerant(driver, stmt);
    }
  });
  // Only re-link FKs when new tables appeared (their references need constraints).
  if (missingTables.length > 0) await provisionForeignKeys(driver, dialect, entities, concurrency);
  if (createdTables > 0 || addedColumns > 0) {
    logger.info("schema reconciled from metadata", { createdTables, addedColumns });
  }
}

/** Applied schema versions from the ledger — surfaced in the admin releases view. */
export async function schemaStatus(): Promise<{ version: number; appliedAt: string }[]> {
  const driver = await getDriver();
  const dialect = await getDialect();
  const res = await driver.query(
    `SELECT ${dialect.id("version")}, ${dialect.id("appliedAt")} FROM ${dialect.table("_schema_migrations")} ORDER BY ${dialect.id("version")} ASC`,
    [],
  );
  return (res.rows as Array<{ version: number; appliedAt: string }>).map((r) => ({
    version: Number(r.version),
    appliedAt: String(r.appliedAt),
  }));
}
