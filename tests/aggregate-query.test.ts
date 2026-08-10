/**
 * Time-capable aggregation: the query contract and its SQL rendering.
 *
 * Two things are pinned here, both offline:
 *
 *  - `normalizeAggregate`, which folds the deprecated single-field `groupBy`
 *    into `dimensions` so the SQL and in-memory adapters cannot drift on what a
 *    query means;
 *  - `dateBucketExpr` per bucket per dialect. Dates are stored as ISO-8601
 *    *strings*, so bucketing is prefixing rather than calendar arithmetic —
 *    which is why day/month/year render identically on both engines and only
 *    `quarter` diverges. A change here silently reshapes every report.
 *
 * The in-memory adapter's bucketing is checked against the same expectations,
 * because a report must not change shape between AULA_PERSISTENCE=memory and a
 * real database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGGREGATE_MAX_GROUPS,
  dateRangeFilters,
  normalizeAggregate,
  type DateBucket,
} from "@/lib/data/query";
import type { AggregateRow } from "@/lib/data/query";
import { mssqlDialect } from "@/lib/data/sql/mssql-dialect";
import { mysqlDialect } from "@/lib/data/sql/mysql-dialect";
import { InMemoryRepository } from "@/lib/data/memory-repository";
import type { EntityRecord } from "@/lib/metadata/types";

// ---- normalizeAggregate ----------------------------------------------------

test("the deprecated groupBy folds into dimensions[0]", () => {
  const q = normalizeAggregate({ groupBy: "stage", measures: [{ op: "count", as: "c" }] });
  assert.deepEqual(q.dimensions, [{ field: "stage", bucket: undefined, as: "stage" }]);
});

test("explicit dimensions win over groupBy", () => {
  const q = normalizeAggregate({
    groupBy: "stage",
    dimensions: [{ field: "issueDate", bucket: "month", as: "period" }],
    measures: [{ op: "count", as: "c" }],
  });
  assert.equal(q.dimensions.length, 1);
  assert.equal(q.dimensions[0]!.as, "period");
  assert.equal(q.dimensions[0]!.bucket, "month");
});

test("a dimension's output key defaults to its field name", () => {
  const q = normalizeAggregate({ dimensions: [{ field: "warehouseId" }], measures: [] });
  assert.equal(q.dimensions[0]!.as, "warehouseId");
});

test("no groupBy and no dimensions means a single total row", () => {
  assert.deepEqual(normalizeAggregate({ measures: [{ op: "count", as: "c" }] }).dimensions, []);
});

test("limit defaults to, and is capped at, AGGREGATE_MAX_GROUPS", () => {
  assert.equal(normalizeAggregate({ measures: [] }).limit, AGGREGATE_MAX_GROUPS);
  assert.equal(normalizeAggregate({ measures: [], limit: 10 }).limit, 10);
  assert.equal(normalizeAggregate({ measures: [], limit: 10_000_000 }).limit, AGGREGATE_MAX_GROUPS);
});

// ---- date range filters ----------------------------------------------------

test("a date range is half-open so datetimes on the last day are included", () => {
  // `lte "2026-12-31"` would sort BEFORE "2026-12-31T14:00:00.000Z" and drop it.
  assert.deepEqual(dateRangeFilters("movedAt", "2026-01-01", "2027-01-01"), [
    { field: "movedAt", op: "gte", value: "2026-01-01" },
    { field: "movedAt", op: "lt", value: "2027-01-01" },
  ]);
  assert.deepEqual(dateRangeFilters("movedAt"), []);
});

// ---- date bucketing: SQL rendering ----------------------------------------

test("day/month/year bucket to identical prefix expressions on both engines", () => {
  for (const [bucket, len] of [["year", 4], ["month", 7], ["day", 10]] as const) {
    assert.equal(mssqlDialect.dateBucketExpr("[issueDate]", bucket), `LEFT([issueDate], ${len})`);
    assert.equal(mysqlDialect.dateBucketExpr("`issueDate`", bucket), `LEFT(\`issueDate\`, ${len})`);
  }
});

test("quarter is the one bucket that diverges between the engines", () => {
  // T-SQL: `+` concatenates, `/` on INT is integer division.
  assert.equal(
    mssqlDialect.dateBucketExpr("[issueDate]", "quarter"),
    "(LEFT([issueDate], 4) + '-Q' + CAST((CAST(SUBSTRING([issueDate], 6, 2) AS INT) + 2) / 3 AS VARCHAR(1)))",
  );
  // MySQL: `+` is arithmetic so CONCAT is required, and `/` yields a decimal so
  // integer division needs DIV.
  assert.equal(
    mysqlDialect.dateBucketExpr("`issueDate`", "quarter"),
    "CONCAT(LEFT(`issueDate`, 4), '-Q', (CAST(SUBSTRING(`issueDate`, 6, 2) AS UNSIGNED) + 2) DIV 3)",
  );
});

test("countDistinct renders the same on both engines", () => {
  assert.equal(mssqlDialect.countDistinctExpr("[productId]"), "COUNT(DISTINCT [productId])");
  assert.equal(mysqlDialect.countDistinctExpr("`productId`"), "COUNT(DISTINCT `productId`)");
});

// ---- row locking -----------------------------------------------------------

test("the locking select holds a lock on a MISSING row too", () => {
  // Without that, two transactions both see "no balance row yet" and both
  // insert one — which is exactly the oversell race the lock exists to stop.
  const ms = mssqlDialect.lockingSelect("*", "[dbo].[stockBalance]", "[stockKey] = @p0");
  assert.match(ms, /WITH \(UPDLOCK, ROWLOCK, HOLDLOCK\)/, "MSSQL needs HOLDLOCK for the range lock");
  assert.ok(ms.startsWith("SELECT * FROM [dbo].[stockBalance] WITH"), ms);

  const my = mysqlDialect.lockingSelect("*", "`stockBalance`", "`stockKey` = ?");
  assert.ok(my.endsWith("FOR UPDATE"), "MySQL takes the lock via a trailing FOR UPDATE");
  assert.equal(my, "SELECT * FROM `stockBalance` WHERE `stockKey` = ? FOR UPDATE");
});

// ---- in-memory adapter agrees with the SQL semantics -----------------------

const SCOPE = { tenantId: "T", orgId: "O" };

function row(id: string, issueDate: string, total: number, account: string): EntityRecord {
  return {
    id,
    tenantId: "T",
    orgId: "O",
    ownerId: null,
    createdAt: issueDate,
    updatedAt: issueDate,
    createdBy: "system",
    updatedBy: "system",
    version: 1,
    issueDate,
    total,
    accountId: account,
  };
}

async function seeded(): Promise<InMemoryRepository> {
  const repo = new InMemoryRepository();
  await repo.insert("invoice", row("1", "2026-01-15T10:00:00.000Z", 100, "a1"));
  await repo.insert("invoice", row("2", "2026-01-20T10:00:00.000Z", 200, "a2"));
  await repo.insert("invoice", row("3", "2026-08-05T10:00:00.000Z", 50, "a1"));
  await repo.insert("invoice", row("4", "2025-12-31T23:00:00.000Z", 999, "a1"));
  return repo;
}

test("memory adapter buckets by month and returns one row per period", async () => {
  const repo = await seeded();
  const rows = await repo.aggregate(SCOPE, "invoice", {
    dimensions: [{ field: "issueDate", bucket: "month", as: "period" }],
    measures: [{ op: "sum", field: "total", as: "revenue" }, { op: "count", as: "n" }],
  });
  assert.deepEqual(
    rows.map((r: AggregateRow) => [r.keys.period, r.measures.revenue, r.measures.n]),
    [["2025-12", 999, 1], ["2026-01", 300, 2], ["2026-08", 50, 1]],
  );
});

test("memory adapter buckets by quarter the same way the dialects do", async () => {
  const repo = await seeded();
  const rows = await repo.aggregate(SCOPE, "invoice", {
    dimensions: [{ field: "issueDate", bucket: "quarter", as: "q" }],
    measures: [{ op: "count", as: "n" }],
  });
  assert.deepEqual(rows.map((r: AggregateRow) => r.keys.q), ["2025-Q4", "2026-Q1", "2026-Q3"]);
});

test("memory adapter groups on more than one dimension", async () => {
  const repo = await seeded();
  const rows = await repo.aggregate(SCOPE, "invoice", {
    dimensions: [{ field: "issueDate", bucket: "year", as: "y" }, { field: "accountId" }],
    measures: [{ op: "sum", field: "total", as: "revenue" }],
  });
  assert.deepEqual(
    rows.map((r: AggregateRow) => [r.keys.y, r.keys.accountId, r.measures.revenue]),
    [["2025", "a1", 999], ["2026", "a1", 150], ["2026", "a2", 200]],
  );
});

test("a half-open date range excludes the upper bound", async () => {
  const repo = await seeded();
  const rows = await repo.aggregate(SCOPE, "invoice", {
    filters: dateRangeFilters("issueDate", "2026-01-01", "2026-02-01"),
    measures: [{ op: "sum", field: "total", as: "revenue" }],
  });
  assert.equal(rows.length, 1, "an ungrouped aggregate is always one row");
  assert.equal(rows[0]!.measures.revenue, 300);
  assert.equal(rows[0]!.key, null, "the ungrouped row has no key");
});

test("countDistinct counts distinct values, not rows", async () => {
  const repo = await seeded();
  const rows = await repo.aggregate(SCOPE, "invoice", {
    measures: [{ op: "countDistinct", field: "accountId", as: "customers" }, { op: "count", as: "n" }],
  });
  assert.equal(rows[0]!.measures.customers, 2);
  assert.equal(rows[0]!.measures.n, 4);
});

test("having filters groups after aggregation", async () => {
  const repo = await seeded();
  const rows = await repo.aggregate(SCOPE, "invoice", {
    dimensions: [{ field: "accountId" }],
    measures: [{ op: "sum", field: "total", as: "revenue" }],
    having: [{ measure: "revenue", op: "gt", value: 500 }],
  });
  assert.deepEqual(rows.map((r: AggregateRow) => r.keys.accountId), ["a1"]);
});

test("sort by a measure, descending", async () => {
  const repo = await seeded();
  const rows = await repo.aggregate(SCOPE, "invoice", {
    dimensions: [{ field: "accountId" }],
    measures: [{ op: "sum", field: "total", as: "revenue" }],
    sort: [{ by: "revenue", dir: "desc" }],
  });
  assert.deepEqual(rows.map((r: AggregateRow) => r.keys.accountId), ["a1", "a2"]);
});

test("the deprecated groupBy/key shape still works for existing callers", async () => {
  const repo = await seeded();
  const rows = await repo.aggregate(SCOPE, "invoice", {
    groupBy: "accountId",
    measures: [{ op: "count", as: "c" }],
  });
  // `key` is what callers written before dimensions existed read.
  assert.deepEqual(rows.map((r: AggregateRow) => [r.key, r.measures.c]), [["a1", 3], ["a2", 1]]);
});

test("limit caps the number of groups returned", async () => {
  const repo = await seeded();
  const rows = await repo.aggregate(SCOPE, "invoice", {
    dimensions: [{ field: "issueDate", bucket: "month", as: "period" }],
    measures: [{ op: "count", as: "n" }],
    limit: 2,
  });
  assert.equal(rows.length, 2);
});

test("every bucket is exercised", () => {
  // Guards against a new DateBucket being added without a rendering for it.
  const buckets: DateBucket[] = ["day", "month", "quarter", "year"];
  for (const b of buckets) {
    assert.ok(mssqlDialect.dateBucketExpr("[d]", b), `mssql: ${b}`);
    assert.ok(mysqlDialect.dateBucketExpr("`d`", b), `mysql: ${b}`);
  }
});
