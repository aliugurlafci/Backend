/**
 * Dialect rendering unit checks (no database needed).
 *
 * These pin the SQL fragments that diverge between SQL Server and MySQL —
 * identifier quoting, placeholders, pagination parameter ORDER (critical for
 * MySQL's positional `?` binding), LIKE/ESCAPE, exists-limit and inserted-id
 * retrieval — so a regression in either dialect is caught offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mssqlDialect } from "@/lib/data/sql/mssql-dialect";
import { mysqlDialect } from "@/lib/data/sql/mysql-dialect";
import type { SqlType } from "@/lib/data/sql/types";
import type { SqlDialect } from "@/lib/data/sql/dialect";

/** A binder that records bound values in order and hands back real placeholders. */
function recorder(dialect: SqlDialect) {
  const values: unknown[] = [];
  const bind = (value: unknown, _type: SqlType) => {
    const ph = dialect.placeholder(values.length);
    values.push(value);
    return ph;
  };
  return { values, bind };
}

test("identifier + table quoting", () => {
  assert.equal(mssqlDialect.id("account"), "[account]");
  assert.equal(mssqlDialect.table("account"), "[dbo].[account]");
  assert.equal(mysqlDialect.id("account"), "`account`");
  assert.equal(mysqlDialect.table("account"), "`account`");
  // reserved words are always quoted, so they're safe as identifiers.
  assert.equal(mysqlDialect.id("key"), "`key`");
});

test("placeholders: named (@pN) on MSSQL, positional (?) on MySQL", () => {
  assert.equal(mssqlDialect.placeholder(0), "@p0");
  assert.equal(mssqlDialect.placeholder(3), "@p3");
  assert.equal(mysqlDialect.placeholder(0), "?");
  assert.equal(mysqlDialect.placeholder(3), "?");
});

test("pagination binds offset+limit in each engine's required order", () => {
  const ms = recorder(mssqlDialect);
  const msClause = mssqlDialect.paginate(ms.bind, 20, 10); // offset=20, limit=10
  assert.equal(msClause, "OFFSET @p0 ROWS FETCH NEXT @p1 ROWS ONLY");
  assert.deepEqual(ms.values, [20, 10]); // offset first, then limit

  const my = recorder(mysqlDialect);
  const myClause = mysqlDialect.paginate(my.bind, 20, 10);
  assert.equal(myClause, "LIMIT ? OFFSET ?");
  assert.deepEqual(my.values, [10, 20]); // limit first, then offset — matches `?` order
});

test("LIKE clause + wildcard escaping", () => {
  assert.equal(mssqlDialect.likeClause("[name]", "@p0"), "[name] LIKE @p0 ESCAPE '!'");
  assert.equal(mysqlDialect.likeClause("`name`", "?"), "`name` LIKE ? ESCAPE '!'");
  // `[` is a wildcard in T-SQL LIKE (escaped) but a literal in MySQL (not escaped).
  assert.equal(mssqlDialect.escapeLikePattern("a_b%[c]!"), "a!_b!%![c]!!");
  assert.equal(mysqlDialect.escapeLikePattern("a_b%[c]!"), "a!_b!%[c]!!");
});

test("exists-limit form", () => {
  assert.equal(mssqlDialect.existsSelect("FROM [dbo].[x] WHERE 1=1"), "SELECT TOP 1 1 AS x FROM [dbo].[x] WHERE 1=1");
  assert.equal(mysqlDialect.existsSelect("FROM `x` WHERE 1=1"), "SELECT 1 AS x FROM `x` WHERE 1=1 LIMIT 1");
});

test("avg cast differs; MySQL needs no CAST", () => {
  assert.equal(mssqlDialect.avgExpr("[amount]"), "AVG(CAST([amount] AS FLOAT))");
  assert.equal(mysqlDialect.avgExpr("`amount`"), "AVG(`amount`)");
});

test("inserted-id retrieval: OUTPUT on MSSQL, none on MySQL", () => {
  assert.equal(mssqlDialect.returningId("id"), "OUTPUT INSERTED.[id] AS [id]");
  assert.equal(mysqlDialect.returningId("id"), "");
});

test("explicit-id insert wrapping: IDENTITY_INSERT on MSSQL, passthrough on MySQL", () => {
  const stmt = "INSERT INTO t (x) VALUES (1)";
  assert.equal(
    mssqlDialect.wrapIdentityInsert("[dbo].[t]", stmt),
    "SET IDENTITY_INSERT [dbo].[t] ON; INSERT INTO t (x) VALUES (1); SET IDENTITY_INSERT [dbo].[t] OFF;",
  );
  assert.equal(mysqlDialect.wrapIdentityInsert("`t`", stmt), stmt);
});
