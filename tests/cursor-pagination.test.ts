/**
 * Keyset (cursor) pagination.
 *
 * Offset paging asks for "the rows after the first N". That is not a stable
 * request: an insert before the current position shifts every later row down
 * one, so the next page starts one row late and the row that crossed the
 * boundary is never returned. The two callers that walk whole tables — the
 * export endpoint and the search reindex — are exactly the ones where that
 * matters, because the symptom is a file that is quietly short and records
 * nobody can find. A cursor names a row instead of a count, so it stays put.
 *
 * Measured on the same ten rows, inserting one row after the first page: the
 * offset walk returned 11 rows with one of them twice; the cursor walk returned
 * 10, each once.
 *
 * The cases below are the ones where a keyset implementation is usually wrong:
 * ties on the sort key, NULLs at either end of the ordering, and rows changing
 * underneath the walk.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import type { RequestContext } from "@/lib/context/types";

const { getQueryEngine } = await import("@/lib/data/store");
const { systemContext } = await import("@/lib/context/resolver");
const { TENANT_ID, ORG_ID } = await import("@/lib/config/env");
const { encodeCursor, sortFingerprint } = await import("@/lib/data/query");

const ctx = (): RequestContext => systemContext(TENANT_ID, ORG_ID);

let run = 0;
/** `count` products in one warehouse-free batch, tagged so a case sees only its own. */
async function seed(count: number, name: (i: number) => string): Promise<string> {
  const qe = await getQueryEngine();
  const tag = `CUR${++run}`;
  for (let i = 0; i < count; i++) {
    await qe.create(ctx(), "product", { name: name(i), sku: `${tag}-${i}`, unitPrice: i, trackStock: false });
  }
  return tag;
}

const mine = (tag: string) => ({ filters: [{ field: "sku", op: "contains" as const, value: `${tag}-` }] });

/** Walk with `listAll` and collect every sku it yields. */
async function walk(tag: string, pageSize: number, extra: Record<string, unknown> = {}): Promise<string[]> {
  const qe = await getQueryEngine();
  const seen: string[] = [];
  await qe.listAll(ctx(), "product", { ...mine(tag), pageSize, ...extra }, (batch) => {
    for (const r of batch) seen.push(String(r.sku));
  });
  return seen;
}

test("a walk visits every row exactly once", async () => {
  const tag = await seed(25, (i) => `P${i}`);
  const seen = await walk(tag, 4); // deliberately not a divisor of 25
  assert.equal(seen.length, 25);
  assert.equal(new Set(seen).size, 25, "no row appears twice");
});

test("a page size larger than the set returns everything in one go", async () => {
  const tag = await seed(3, (i) => `S${i}`);
  assert.equal((await walk(tag, 100)).length, 3);
});

test("an empty result set terminates immediately", async () => {
  assert.deepEqual(await walk("CUR-nothing-matches", 10), []);
});

test("rows sharing the sort key are still visited exactly once", async () => {
  // THE case keyset pagination gets wrong. Every seeded record here has the
  // same `unitPrice`, and `createdAt` — the default sort — is equal too at this
  // clock resolution. Without the id tiebreaker the boundary between pages is
  // ambiguous, and rows fall through it or repeat.
  const qe = await getQueryEngine();
  const tag = `CURTIE${++run}`;
  for (let i = 0; i < 12; i++) {
    await qe.create(ctx(), "product", { name: "same", sku: `${tag}-${i}`, unitPrice: 5, trackStock: false });
  }
  const seen: string[] = [];
  await qe.listAll(
    ctx(),
    "product",
    { filters: [{ field: "sku", op: "contains", value: `${tag}-` }], sort: [{ field: "unitPrice", dir: "asc" }], pageSize: 5 },
    (batch) => {
      for (const r of batch) seen.push(String(r.sku));
    },
  );
  assert.equal(seen.length, 12);
  assert.equal(new Set(seen).size, 12, "identical sort keys must not merge or drop rows");
});

test("a row inserted ahead of the walk does not displace one that was pending", async () => {
  // The offset bug, stated as a test. Reading page 1 by offset and then
  // inserting a row that sorts BEFORE the current position pushes the rest down
  // by one, so the first row of page 2 is the one already returned and the last
  // row of the old page 2 is never read. With a cursor the position is a row,
  // so the shift is invisible.
  const qe = await getQueryEngine();
  const tag = `CURINS${++run}`;
  // Prices start at 1 so that 0 is available below as a value that sorts ahead
  // of everything — `unitPrice` is validated as non-negative, so -1 is not.
  for (let i = 0; i < 10; i++) {
    await qe.create(ctx(), "product", { name: `N${i}`, sku: `${tag}-${String(i).padStart(2, "0")}`, unitPrice: i + 1, trackStock: false });
  }
  const query = { filters: [{ field: "sku", op: "contains" as const, value: `${tag}-` }], sort: [{ field: "unitPrice", dir: "asc" as const }], pageSize: 4 };

  const first = await qe.listByCursor(ctx(), "product", query);
  assert.equal(first.items.length, 4);

  // Sorts at the very front, behind the cursor.
  await qe.create(ctx(), "product", { name: "jumped", sku: `${tag}-XX`, unitPrice: 0, trackStock: false });

  const seen = first.items.map((r) => String(r.sku));
  let cursor = first.nextCursor;
  while (cursor) {
    const next = await qe.listByCursor(ctx(), "product", query, cursor);
    for (const r of next.items) seen.push(String(r.sku));
    cursor = next.nextCursor;
  }
  assert.equal(new Set(seen).size, seen.length, "no row is returned twice");
  // All ten originals, whatever happened to the interloper.
  for (let i = 0; i < 10; i++) {
    assert.ok(seen.includes(`${tag}-${String(i).padStart(2, "0")}`), `${tag}-${i} was skipped`);
  }
});

test("deleting the cursor's own row does not strand the walk", async () => {
  // The cursor is a set of VALUES, not a pointer to a row that has to still
  // exist. An implementation that resumed by looking the row up would stop dead
  // here and report a short result.
  const qe = await getQueryEngine();
  const tag = `CURDEL${++run}`;
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    const rec = await qe.create(ctx(), "product", { name: `D${i}`, sku: `${tag}-${i}`, unitPrice: i, trackStock: false });
    ids.push(String(rec.id));
  }
  const query = { filters: [{ field: "sku", op: "contains" as const, value: `${tag}-` }], sort: [{ field: "unitPrice", dir: "asc" as const }], pageSize: 4 };

  const first = await qe.listByCursor(ctx(), "product", query);
  const lastOfPage = first.items[first.items.length - 1];
  await qe.remove(ctx(), "product", String(lastOfPage?.id));

  const rest = await qe.listByCursor(ctx(), "product", query, first.nextCursor);
  assert.equal(rest.items.length, 4, "the remaining rows still arrive");
  assert.equal(String(rest.items[0]?.sku), `${tag}-4`);
});

test("null sort values are ordered consistently in both directions", async () => {
  // Both engines sort NULL below every value — first ascending, last
  // descending — and the cursor predicate has a separate branch for each. Get
  // it wrong and the rows with no value are either all skipped or all repeated.
  const qe = await getQueryEngine();
  const tag = `CURNULL${++run}`;
  for (let i = 0; i < 4; i++) {
    await qe.create(ctx(), "product", { name: `V${i}`, sku: `${tag}-v${i}`, unitPrice: i, barcode: `${tag}B${i}`, trackStock: false });
  }
  for (let i = 0; i < 4; i++) {
    await qe.create(ctx(), "product", { name: `N${i}`, sku: `${tag}-n${i}`, unitPrice: i, trackStock: false });
  }
  for (const dir of ["asc", "desc"] as const) {
    const seen = await walk(tag, 3, { sort: [{ field: "barcode", dir }] });
    assert.equal(seen.length, 8, `${dir}: every row, including the four with no barcode`);
    assert.equal(new Set(seen).size, 8, `${dir}: no row twice`);
  }
});

test("a cursor minted under a different sort is refused, not ignored", async () => {
  // Ignoring it restarts the walk from the top and re-delivers everything the
  // caller already has, which no caller can detect.
  const qe = await getQueryEngine();
  const tag = await seed(6, (i) => `X${i}`);
  const byPrice = { ...mine(tag), sort: [{ field: "unitPrice", dir: "asc" as const }], pageSize: 2 };
  const page = await qe.listByCursor(ctx(), "product", byPrice);
  assert.ok(page.nextCursor);

  await assert.rejects(
    () => qe.listByCursor(ctx(), "product", { ...mine(tag), sort: [{ field: "name", dir: "asc" }], pageSize: 2 }, page.nextCursor),
    /cursor does not match/,
  );
});

test("a corrupt cursor is refused rather than silently restarting", async () => {
  const qe = await getQueryEngine();
  const tag = await seed(3, (i) => `C${i}`);
  await assert.rejects(() => qe.listByCursor(ctx(), "product", mine(tag), "not-a-cursor"), /cursor does not match/);
  await assert.rejects(
    () => qe.listByCursor(ctx(), "product", mine(tag), encodeCursor({ values: [], id: "1", sort: "nope:asc" })),
    /cursor does not match/,
  );
});

test("the last page carries no cursor", async () => {
  const qe = await getQueryEngine();
  const tag = await seed(5, (i) => `L${i}`);
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await qe.listByCursor(ctx(), "product", { ...mine(tag), pageSize: 2 }, cursor);
    pages++;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
    assert.ok(pages < 10, "the walk must terminate");
  }
  assert.ok(pages >= 3);
});

test("the fingerprint distinguishes orderings that differ only by direction", () => {
  assert.notEqual(
    sortFingerprint([{ field: "name", dir: "asc" }]),
    sortFingerprint([{ field: "name", dir: "desc" }]),
  );
  assert.notEqual(
    sortFingerprint([{ field: "a", dir: "asc" }, { field: "b", dir: "asc" }]),
    sortFingerprint([{ field: "b", dir: "asc" }, { field: "a", dir: "asc" }]),
  );
});
