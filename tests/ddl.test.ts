/**
 * Schema/DDL unit checks for the INT IDENTITY id scheme.
 *
 * The live MSSQL database is unreachable in this environment, so the actual
 * IDENTITY / OUTPUT / IDENTITY_INSERT *execution* cannot be exercised here.
 * These tests pin the generated DDL + column descriptors that drive it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { entityColumns, isIdLike, type ColumnDesc } from "@/lib/data/mssql/schema-map";
import { entityStatements } from "@/lib/data/mssql/ddl";
import { metadata } from "@/lib/metadata";

const dealer = metadata.getEntity("dealer"); // has reference (branchId, contactId) + currency (creditLimit)
const cols = entityColumns(dealer);
const col = (name: string): ColumnDesc => cols.find((c) => c.name === name)!;

test("id is an INT IDENTITY, id-like PK", () => {
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

test("version is INT but NOT id-like; currency stays FLOAT and not id-like", () => {
  assert.equal(col("version").kind, "int");
  assert.equal(isIdLike(col("version")), false);
  assert.equal(col("creditLimit").kind, "float");
  assert.equal(isIdLike(col("creditLimit")), false);
});

test("ownership system columns stay NVARCHAR (hold the 'system' sentinel)", () => {
  for (const name of ["ownerId", "createdBy", "updatedBy", "tenantId", "orgId"]) {
    assert.equal(col(name).kind, "nvarchar", `${name} should be nvarchar`);
  }
});

test("DDL emits INT IDENTITY id, INT reference columns and the id PK", () => {
  const ddl = entityStatements(dealer).join("\n");
  assert.match(ddl, /\[id\] INT IDENTITY\(1,1\) NOT NULL/);
  assert.match(ddl, /\[branchId\] INT NULL/);
  assert.match(ddl, /PRIMARY KEY \(\[id\]\)/);
});
