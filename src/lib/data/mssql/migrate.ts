/**
 * Schema migration + self-healing reconcile — the single place that provisions
 * the physical MSSQL schema from the metadata entity definitions.
 *
 * Two modes, chosen automatically:
 *
 *  1. Full provision (first boot, or after a `SCHEMA_VERSION` bump): apply the
 *     complete guarded DDL for every entity (tables, additive columns, indexes)
 *     plus the foreign keys, then record the version so it runs once. Bump the
 *     version when you change something the cheap reconcile can't see on its own
 *     (a new index or FK on an already-existing table).
 *
 *  2. Reconcile (every other boot): introspect the live schema in a single query
 *     and emit DDL only for genuine differences — create any entity table that's
 *     missing (a new entity) and add any missing nullable column (a new field).
 *     This makes adding an entity/field "just work" on the next boot WITHOUT a
 *     version bump, so a new table can never be silently absent again.
 *
 * All DDL comes from `ddl.ts` and every statement is idempotent, so both modes
 * are safe to re-run. Provisioning is entity-parallel (bounded by the pool) so a
 * cloud-SQL first boot of ~50 tables stays well under a minute.
 */
import type { EntityDef } from "@/lib/metadata/types";
import type { ConnectionPool } from "mssql";
import { metadata } from "@/lib/metadata";
import { env } from "@/lib/config/env";
import { systemClock } from "@/lib/core/clock";
import { logger } from "@/lib/observability/logger";
import { ensureDatabase, getPool } from "./connection";
import {
  entityStatements,
  allForeignKeyStatements,
  supportStatements,
  missingColumnStatements,
} from "./ddl";

// Bump this whenever a schema change can't be picked up by the cheap reconcile —
// i.e. a new index or foreign key on an EXISTING table. New entities and new
// nullable fields are applied automatically by the reconcile without a bump.
// v3: currency columns DECIMAL(18,2) + foreign-key constraints.
// v4: `mobileScreenConfig` entity (mobile screen-visibility layer).
const SCHEMA_VERSION = 4;

type Pool = ConnectionPool;

/** Run `fn` over `items` with at most `concurrency` in flight (never exceeds the
 *  connection-pool size). Rejects on the first error. */
async function mapPool<T>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  };
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
}

/** Concurrency for provisioning: a lane below the pool max so a stray query isn't
 *  starved, and never below 2. */
function ddlConcurrency(): number {
  return Math.max(2, (env.MSSQL_POOL_MAX || 8) - 1);
}

/** Has this schema version already been fully provisioned? */
async function isVersionApplied(pool: Pool): Promise<boolean> {
  const applied = await pool
    .request()
    .input("v", SCHEMA_VERSION)
    .query(`SELECT 1 AS ok FROM [dbo].[_schema_migrations] WHERE [version] = @v`);
  return applied.recordset.length > 0;
}

/** Record the current schema version so the full provision runs exactly once. */
async function recordVersion(pool: Pool): Promise<void> {
  await pool
    .request()
    .input("v", SCHEMA_VERSION)
    .input("at", systemClock.isoNow())
    .query(
      `IF NOT EXISTS (SELECT 1 FROM [dbo].[_schema_migrations] WHERE [version] = @v) ` +
        `INSERT INTO [dbo].[_schema_migrations] ([version], [appliedAt]) VALUES (@v, @at);`,
    );
}

/** One query → the live set of `dbo` tables and each table's columns. */
async function introspectSchema(pool: Pool): Promise<{ tables: Set<string>; columns: Map<string, Set<string>> }> {
  const tables = new Set<string>();
  const columns = new Map<string, Set<string>>();
  const res = await pool.request().query(
    `SELECT t.name AS tbl, c.name AS col
       FROM sys.tables t
       JOIN sys.columns c ON c.object_id = t.object_id
      WHERE t.schema_id = SCHEMA_ID('dbo')`,
  );
  for (const row of res.recordset as { tbl: string; col: string }[]) {
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
async function provisionForeignKeys(pool: Pool, entities: EntityDef[], concurrency: number): Promise<void> {
  const fkStatements = allForeignKeyStatements(entities);
  let ok = 0;
  await mapPool(fkStatements, concurrency, async (stmt) => {
    try {
      await pool.request().batch(stmt);
      ok++;
    } catch (e) {
      logger.warn("foreign-key statement skipped", { error: String(e), stmt });
    }
  });
  logger.info("foreign keys provisioned", { ok, total: fkStatements.length });
}

export async function runMigrations(): Promise<void> {
  // Create the target database first if it doesn't exist yet.
  await ensureDatabase();
  const pool = await getPool();

  // Support tables (schema-version ledger, sequence counters, file blobs) — cheap
  // + idempotent, and needed before we can read the ledger.
  for (const stmt of supportStatements()) {
    await pool.request().batch(stmt);
  }

  const entities = metadata.listEntities();
  const concurrency = ddlConcurrency();
  const versioned = await isVersionApplied(pool);

  if (!versioned) {
    // First boot for this version: full guarded provision (tables + columns +
    // indexes), then FKs, then record the version so this heavy pass runs once.
    logger.info("provisioning schema (full)", { version: SCHEMA_VERSION, entities: entities.length, concurrency });
    let stmtCount = 0;
    await mapPool(entities, concurrency, async (entity) => {
      for (const stmt of entityStatements(entity)) {
        try {
          await pool.request().batch(stmt);
          stmtCount++;
        } catch (e) {
          logger.error("migration statement failed", { error: String(e), entity: entity.name, stmt });
          throw e;
        }
      }
    });
    await provisionForeignKeys(pool, entities, concurrency);
    await recordVersion(pool);
    logger.info("schema migration complete", { version: SCHEMA_VERSION, entities: entities.length, statements: stmtCount });
    return;
  }

  // Already provisioned: cheap self-healing reconcile. Introspect once, then emit
  // DDL only for real gaps — a new entity's table or a new field's column.
  const { tables, columns } = await introspectSchema(pool);
  const missingTables = entities.filter((e) => !tables.has(e.name));
  let createdTables = 0;
  let addedColumns = 0;
  await mapPool(entities, concurrency, async (entity) => {
    if (!tables.has(entity.name)) {
      for (const stmt of entityStatements(entity)) await pool.request().batch(stmt);
      createdTables++;
    } else {
      const existing = columns.get(entity.name) ?? new Set<string>();
      for (const stmt of missingColumnStatements(entity, existing)) {
        await pool.request().batch(stmt);
        addedColumns++;
      }
    }
  });
  // Only re-link FKs when new tables appeared (their references need constraints).
  if (missingTables.length > 0) await provisionForeignKeys(pool, entities, concurrency);
  if (createdTables > 0 || addedColumns > 0) {
    logger.info("schema reconciled from metadata", { createdTables, addedColumns });
  }
}

/** Applied schema versions from the ledger — the single source of truth for what
 *  the DB has been provisioned to (surfaced in the admin releases view). */
export async function schemaStatus(): Promise<{ version: number; appliedAt: string }[]> {
  const pool = await getPool();
  const res = await pool
    .request()
    .query(`SELECT [version], [appliedAt] FROM [dbo].[_schema_migrations] ORDER BY [version] ASC`);
  return (res.recordset as { version: number; appliedAt: string }[]).map((r) => ({ version: r.version, appliedAt: r.appliedAt }));
}
