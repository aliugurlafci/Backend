/**
 * CLI: re-scope existing rows to a new tenant / organisation.
 *
 * `tenantId` / `orgId` are stamped on every record, so changing AULA_TENANT_ID
 * or AULA_ORG_ID after data exists leaves that data unreachable — the app only
 * ever reads the configured scope. This script rewrites the old scope to the new
 * one across every table that carries the columns, inside one transaction.
 *
 *   npm run retenant -- --from-tenant "AULA-CRM" --from-org "Uğur Corp"
 *   npm run retenant -- --from-tenant "AULA-CRM" --from-org "Uğur Corp" --apply
 *
 * Without `--apply` it only reports what would change (dry run). The target
 * scope is always the configured AULA_TENANT_ID / AULA_ORG_ID, so set those in
 * `.env` first, then run this with the *previous* values.
 */
import { ORG_ID, TENANT_ID } from "@/lib/config/env";
import { closePool } from "@/lib/data/sql/connection";
import { getDialect } from "@/lib/data/sql/dialect";
import { getDriver } from "@/lib/data/sql/driver";
import { T, type BoundParam } from "@/lib/data/sql/types";
import { metadata } from "@/lib/metadata";
import { logger } from "@/lib/observability/logger";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Bind a scope value as a bounded string parameter (tenantId/orgId columns). */
const p = (value: string): BoundParam => ({ value, type: T.string(80) });

async function main(): Promise<void> {
  const fromTenant = arg("from-tenant");
  const fromOrg = arg("from-org");
  const apply = process.argv.includes("--apply");

  if (!fromTenant || !fromOrg) {
    throw new Error('usage: npm run retenant -- --from-tenant "<old tenant>" --from-org "<old org>" [--apply]');
  }
  if (fromTenant === TENANT_ID && fromOrg === ORG_ID) {
    throw new Error("source and target scope are identical — set the new AULA_TENANT_ID / AULA_ORG_ID in .env first");
  }

  const driver = await getDriver();
  const dialect = await getDialect();
  // Every metadata entity table carries tenantId/orgId; the support tables
  // (migration ledger, sequence counter, file blobs) do not.
  const tables = metadata.listEntities().map((e) => e.name);

  let total = 0;
  const changed: { table: string; rows: number }[] = [];

  await driver.transaction(async () => {
    for (const table of tables) {
      const ref = dialect.table(table);
      const where = `WHERE ${dialect.id("tenantId")} = ${dialect.placeholder(0)} AND ${dialect.id("orgId")} = ${dialect.placeholder(1)}`;
      let count = 0;
      try {
        const result = await driver.query(`SELECT COUNT(*) AS c FROM ${ref} ${where}`, [p(fromTenant), p(fromOrg)]);
        count = Number((result.rows[0] as { c: number }).c);
      } catch {
        continue; // table absent (metadata newer than the schema) — skip it
      }
      if (count === 0) continue;
      changed.push({ table, rows: count });
      total += count;
      if (apply) {
        await driver.query(
          `UPDATE ${ref} SET ${dialect.id("tenantId")} = ${dialect.placeholder(0)}, ${dialect.id("orgId")} = ${dialect.placeholder(1)} ` +
            `WHERE ${dialect.id("tenantId")} = ${dialect.placeholder(2)} AND ${dialect.id("orgId")} = ${dialect.placeholder(3)}`,
          [p(TENANT_ID), p(ORG_ID), p(fromTenant), p(fromOrg)],
        );
      }
    }
    if (!apply) throw new DryRun(); // roll back the (empty) transaction
  }).catch((error) => {
    if (!(error instanceof DryRun)) throw error;
  });

  for (const c of changed) logger.info("scope", { table: c.table, rows: c.rows });
  logger.info(apply ? "retenant applied" : "retenant dry run (pass --apply to write)", {
    from: `${fromTenant} / ${fromOrg}`,
    to: `${TENANT_ID} / ${ORG_ID}`,
    tables: changed.length,
    rows: total,
  });
  await closePool();
}

/** Sentinel used to roll back the dry run. */
class DryRun extends Error {}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("retenant failed", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
