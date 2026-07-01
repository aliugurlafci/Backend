/**
 * Unit checks for the boot-time schema reconcile — the logic that makes a new
 * entity/field self-provision without a SCHEMA_VERSION bump. `missingColumnStatements`
 * is the pure core: given the columns a table already has, it must emit ADDs only
 * for the nullable fields that are absent, and never touch NOT NULL system columns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { metadata } from "@/lib/metadata";
import { entityColumns } from "@/lib/data/mssql/schema-map";
import { missingColumnStatements } from "@/lib/data/mssql/ddl";

const e = metadata.getEntity("mobileScreenConfig");
const allCols = entityColumns(e).map((c) => c.name);

test("no ADDs when every column already exists", () => {
  const existing = new Set(allCols);
  assert.deepEqual(missingColumnStatements(e, existing), []);
});

test("emits an ADD only for the absent nullable columns", () => {
  const existing = new Set(allCols.filter((n) => n !== "screens" && n !== "active"));
  const stmts = missingColumnStatements(e, existing);
  assert.equal(stmts.length, 2);
  assert.ok(stmts.some((s) => s.includes("[screens]")), "should add screens");
  assert.ok(stmts.some((s) => s.includes("[active]")), "should add active");
  assert.ok(stmts.every((s) => s.startsWith("ALTER TABLE [dbo].[mobileScreenConfig] ADD ")));
});

test("never adds NOT NULL system columns even when absent", () => {
  const stmts = missingColumnStatements(e, new Set()); // pretend the table has no columns
  const joined = stmts.join("\n");
  for (const sys of ["[id]", "[tenantId]", "[orgId]", "[createdAt]", "[version]"]) {
    assert.ok(!joined.includes(`ADD ${sys}`), `must not add system column ${sys}`);
  }
  // …but it does offer the nullable business columns.
  assert.ok(joined.includes("[clientId]"));
});
