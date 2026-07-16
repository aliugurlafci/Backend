/**
 * Schema/DDL unit checks for the auto-increment id scheme, across both dialects.
 *
 * A live database is unreachable in this environment, so the actual
 * IDENTITY / OUTPUT / AUTO_INCREMENT *execution* cannot be exercised here.
 * These tests pin the generated DDL + column descriptors that drive it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { entityColumns, isIdLike, type ColumnDesc } from "@/lib/data/sql/schema-map";
import { entityStatements } from "@/lib/data/sql/ddl";
import { mssqlDialect } from "@/lib/data/sql/mssql-dialect";
import { mysqlDialect } from "@/lib/data/sql/mysql-dialect";
import { metadata } from "@/lib/metadata";

const dealer = metadata.getEntity("dealer"); // has reference (branchId) + currency (creditLimit)
const cols = entityColumns(dealer);
const col = (name: string): ColumnDesc => cols.find((c) => c.name === name)!;

test("id is an auto-increment, id-like INT PK", () => {
  const id = col("id");
  assert.equal(id.kind, "int");
  assert.equal(id.identity, true);
  assert.equal(isIdLike(id), true);
});

test("reference columns are INT and id-like", () => {
  const branchId = col("branchId");
  assert.equal(branchId.kind, "int");
  assert.equal(isIdLike(branchId), true);
});

test("version is INT but NOT id-like; currency is DECIMAL(18,2) and not id-like", () => {
  assert.equal(col("version").kind, "int");
  assert.equal(isIdLike(col("version")), false);
  assert.equal(col("creditLimit").kind, "decimal");
  assert.equal(isIdLike(col("creditLimit")), false);
});

test("ownership system columns stay string-typed (hold the 'system' sentinel)", () => {
  for (const name of ["ownerId", "createdBy", "updatedBy", "tenantId", "orgId"]) {
    assert.equal(col(name).kind, "nvarchar", `${name} should be a string column`);
  }
});

test("MSSQL DDL emits INT IDENTITY id, INT reference columns and the bracketed id PK", () => {
  const ddl = entityStatements(dealer, mssqlDialect).join("\n");
  assert.match(ddl, /\[id\] INT IDENTITY\(1,1\) NOT NULL/);
  assert.match(ddl, /\[branchId\] INT NULL/);
  assert.match(ddl, /PRIMARY KEY \(\[id\]\)/);
  assert.match(ddl, /\[creditLimit\] DECIMAL\(18,2\)/);
  assert.match(ddl, /IF OBJECT_ID\(N'\[dbo\]\.\[dealer\]', N'U'\) IS NULL/);
});

test("MySQL DDL emits AUTO_INCREMENT id, INT reference columns and the backtick id PK", () => {
  const ddl = entityStatements(dealer, mysqlDialect).join("\n");
  assert.match(ddl, /`id` INT NOT NULL AUTO_INCREMENT/);
  assert.match(ddl, /`branchId` INT NULL/);
  assert.match(ddl, /PRIMARY KEY \(`id`\)/);
  assert.match(ddl, /`creditLimit` DECIMAL\(18,2\)/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS `dealer`/);
  assert.match(ddl, /ENGINE=InnoDB DEFAULT CHARSET=utf8mb4/);
  // text/unbounded columns become LONGTEXT, not NVARCHAR(MAX).
  assert.doesNotMatch(ddl, /NVARCHAR/);
});
