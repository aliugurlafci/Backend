/* TEMP diagnostic — verify provisioned state (works for SQL Server + MySQL). */
import { getDriver } from "@/lib/data/sql/driver";
import { getDialect } from "@/lib/data/sql/dialect";
import { schemaStatus } from "@/lib/data/sql/migrate";
import { closePool } from "@/lib/data/sql/connection";
import { metadata } from "@/lib/metadata";

async function main() {
  const driver = await getDriver();
  const dialect = await getDialect();

  // Live tables via dialect introspection (sys.* on SQL Server, information_schema on MySQL).
  const res = await driver.query(dialect.introspectSql(), []);
  const tables = new Set<string>();
  for (const row of res.rows as Array<{ tbl: string }>) tables.add(row.tbl);

  const entities = metadata.listEntities();
  const entityTables = [...tables].filter((t) => !t.startsWith("_"));
  console.log("client:", dialect.client);
  console.log("entity tables in DB:", entityTables.length, "/ expected", entities.length);
  console.log("product table exists:", tables.has("product"));

  const missing = entities.map((e) => e.name).filter((n) => !tables.has(n));
  console.log("missing entity tables:", missing.length ? missing.join(", ") : "(none)");

  const mig = await schemaStatus();
  console.log("_schema_migrations rows:", JSON.stringify(mig));

  await closePool();
}

main().catch((e) => {
  console.error("diag fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
