/* TEMP diagnostic — verify provisioned state. */
import sql from "mssql";
import { env } from "@/lib/config/env";
import { metadata } from "@/lib/metadata";

function cfg(): sql.config {
  return {
    server: env.MSSQL_SERVER,
    port: env.MSSQL_PORT,
    database: env.MSSQL_DATABASE,
    user: env.MSSQL_USER,
    password: env.MSSQL_PASSWORD,
    options: {
      encrypt: env.MSSQL_ENCRYPT,
      trustServerCertificate: env.MSSQL_TRUST_SERVER_CERTIFICATE,
      enableArithAbort: true,
      appName: "aula-boot-diag",
    },
    requestTimeout: 15000,
    connectionTimeout: 10000,
    pool: { max: 2, min: 0, idleTimeoutMillis: 5000 },
  };
}

async function main() {
  const pool = new sql.ConnectionPool(cfg());
  await pool.connect();

  const tables = await pool.request().query(
    `SELECT COUNT(*) AS n FROM sys.tables WHERE name NOT LIKE '\\_%' ESCAPE '\\'`,
  );
  console.log("entity tables in DB:", tables.recordset[0]?.n, "/ expected", metadata.listEntities().length);

  const hasProduct = await pool.request().query(
    `SELECT OBJECT_ID(N'[dbo].[product]') AS oid`,
  );
  console.log("dbo.product exists:", hasProduct.recordset[0]?.oid != null);

  // Which expected entity tables are still missing?
  const existing = await pool.request().query(`SELECT name FROM sys.tables`);
  const have = new Set(existing.recordset.map((r) => String(r.name)));
  const missing = metadata.listEntities().map((e) => e.name).filter((n) => !have.has(n));
  console.log("missing entity tables:", missing.length ? missing.join(", ") : "(none)");

  const mig = await pool.request().query(`SELECT * FROM [dbo].[_schema_migrations] ORDER BY [version]`);
  console.log("_schema_migrations rows:", JSON.stringify(mig.recordset));

  await pool.close();
}

main().catch((e) => {
  console.error("diag fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
