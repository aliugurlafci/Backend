/**
 * The durable search index.
 *
 * The index used to live only in process memory, maintained from an in-process
 * event bus. With two instances that is not a capacity problem but a wrong
 * answer: a record written through instance A was never re-indexed on B, so
 * search returned different results depending on which instance answered, for
 * as long as B stayed up. Verified against two real instances before the fix —
 * create on A, found on A, not found on B.
 *
 * The fix is a table, so the assertions worth making here are the ones about a
 * SHARED index: a second reader sees a write it did not make, a re-index
 * replaces a document rather than adding one, and a delete actually removes it.
 * "A second reader" is a second context against the same store, because what
 * broke was the store being per-process — not anything about processes.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";

const { SqlSearchEngine } = await import("@/lib/search/sql-engine");
const { InMemorySearchEngine } = await import("@/lib/search/engine");
const { systemContext } = await import("@/lib/context/resolver");
const { TENANT_ID, ORG_ID } = await import("@/lib/config/env");
const { buildDocument } = await import("@/lib/search/indexer");

// The SQL engine reads and writes `searchDocument` through the query engine, so
// it runs against the in-memory repository here exactly as it runs against SQL.
const engine = new SqlSearchEngine();
const ctx = () => systemContext(TENANT_ID, ORG_ID);

/**
 * Start from an empty index.
 *
 * Called by every case that counts hits. Without it, a document left by an
 * earlier case matched the next case's term — "18V hammer drill" from the first
 * test made the ranking test find three hits instead of two — and the failure
 * reads as a scoring bug rather than as leaked state.
 */
async function fresh() {
  await engine.clear(ctx());
}

let seq = 0;
const doc = (over: Partial<{ entity: string; id: string; title: string; text: string }> = {}) => ({
  entity: "product",
  id: String(++seq),
  tenantId: TENANT_ID,
  orgId: ORG_ID,
  title: "Widget",
  text: "a blue widget",
  ...over,
});

test("a document written by one reader is found by another", async () => {
  await fresh();
  await engine.index(ctx(), doc({ id: "100", title: "Cordless Drill", text: "18V hammer drill" }));
  const hits = await engine.search(ctx(), "cordless");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.id, "100");
  assert.equal(hits[0]!.title, "Cordless Drill");
});

test("re-indexing a record replaces its document rather than adding one", async () => {
  // The failure this guards is silent: two rows for one record means the record
  // appears twice in every result list, under both its old and its new name.
  await fresh();
  const before = await engine.size(ctx());
  await engine.index(ctx(), doc({ id: "200", title: "Old Name", text: "old" }));
  await engine.index(ctx(), doc({ id: "200", title: "New Name", text: "new" }));
  assert.equal(await engine.size(ctx()), before + 1, "one record, one document");

  assert.equal((await engine.search(ctx(), "New Name")).length, 1);
  assert.equal((await engine.search(ctx(), "Old Name")).length, 0, "the old title must stop matching");
});

test("a removed document stops matching", async () => {
  await fresh();
  await engine.index(ctx(), doc({ id: "300", title: "Doomed", text: "x" }));
  assert.equal((await engine.search(ctx(), "doomed")).length, 1);
  await engine.remove(ctx(), "product", "300");
  assert.equal((await engine.search(ctx(), "doomed")).length, 0);
});

test("removing a document that was never indexed is not an error", async () => {
  // The delete event fires for every entity, including ones with no searchable
  // field and therefore no document. Throwing here would fail the delete itself.
  await engine.remove(ctx(), "product", "does-not-exist");
});

test("a title match outranks a body match", async () => {
  await fresh();
  await engine.index(ctx(), doc({ id: "401", title: "Hammer", text: "steel" }));
  await engine.index(ctx(), doc({ id: "402", title: "Mallet", text: "rubber hammer head" }));
  const hits = await engine.search(ctx(), "hammer");
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.id, "401", "the one named Hammer comes first");
});

test("results can be narrowed to particular entities", async () => {
  await fresh();
  await engine.index(ctx(), doc({ entity: "product", id: "501", title: "Acme Ltd", text: "" }));
  await engine.index(ctx(), doc({ entity: "account", id: "502", title: "Acme Ltd", text: "" }));
  const hits = await engine.search(ctx(), "acme", { entities: ["account"] });
  assert.deepEqual(hits.map((h) => h.entity), ["account"]);
});

test("an empty term matches nothing rather than everything", async () => {
  // `LIKE '%%'` matches every row. Returning the whole index for a blank search
  // box is both useless and the most expensive query the system can run.
  assert.deepEqual(await engine.search(ctx(), ""), []);
  assert.deepEqual(await engine.search(ctx(), "   "), []);
});

test("clearing empties the index", async () => {
  await engine.index(ctx(), doc({ id: "600", title: "Transient", text: "" }));
  await engine.clear(ctx());
  assert.equal(await engine.size(ctx()), 0);
  assert.deepEqual(await engine.search(ctx(), "transient"), []);
});

test("both engines rank the same hits the same way", async () => {
  // Switching persistence must change where results come from, not what order
  // they arrive in — otherwise the same search looks different in test and in
  // production, and the difference is invisible until someone complains.
  const memory = new InMemorySearchEngine();
  const sql = new SqlSearchEngine();
  await sql.clear(ctx());

  const corpus = [
    doc({ id: "701", title: "Drill", text: "cordless" }),
    doc({ id: "702", title: "Cordless Drill", text: "18V" }),
    doc({ id: "703", title: "Battery", text: "for the cordless drill" }),
  ];
  for (const d of corpus) {
    await memory.index(ctx(), d);
    await sql.index(ctx(), d);
  }
  const ids = (hits: Array<{ id: string }>) => hits.map((h) => h.id);
  assert.deepEqual(ids(await sql.search(ctx(), "cordless")), ids(await memory.search(ctx(), "cordless")));
  assert.deepEqual(ids(await sql.search(ctx(), "drill")), ids(await memory.search(ctx(), "drill")));
});

test("buildDocument flattens exactly the searchable fields", async () => {
  // The body is what makes a record findable. A field that is searchable in
  // metadata but missing here is a record nobody can find by that value, and
  // nothing reports it — the search simply returns nothing.
  const { metadata } = await import("@/lib/metadata");
  const product = metadata.getEntity("product");
  const record = {
    id: "1", tenantId: TENANT_ID, orgId: ORG_ID,
    name: "Cordless Drill", sku: "SKU-1", barcode: "8690000000001",
    unitPrice: 100, costPrice: 60, trackStock: true,
  } as unknown as Parameters<typeof buildDocument>[1];

  const built = buildDocument("product", record);
  assert.equal(built.title, "Cordless Drill");
  for (const f of product.fields.filter((x) => x.searchable)) {
    const value = record[f.name];
    if (typeof value === "string") {
      assert.ok(built.text.includes(value), `${f.name} ("${value}") is searchable but absent from the document body`);
    }
  }
  assert.ok(!built.text.includes("60"), "non-searchable fields stay out of the body");
});
