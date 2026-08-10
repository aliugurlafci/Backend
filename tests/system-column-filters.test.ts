/**
 * Filtering and sorting on the columns no `EntityDef` declares.
 *
 * `id`, `createdAt`, `ownerId` and the rest are real columns on every table, but
 * they are not in `entity.fields` — and `toRepoQuery` builds its whitelist from
 * `entity.fields` alone. So a filter naming one was SILENTLY DROPPED and the
 * query ran unfiltered.
 *
 * The worst of it was `listByIds`, which is built entirely on
 * `{field: "id", op: "in", value: [...]}`. Its own doc comment says it exists to
 * replace "read the whole table and build a Map" — and it was doing exactly
 * that, returning the first page of the table instead of the rows asked for.
 * Every name it resolved was whichever record happened to sort first.
 *
 * It looked correct on a small table, which is why it survived: with fewer rows
 * than the page size the unfiltered page contains the right record, and the Map
 * lookup finds it. The failure only appears once the table outgrows a page —
 * that is, in production.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import type { RequestContext } from "@/lib/context/types";

const { getQueryEngine } = await import("@/lib/data/store");
const { systemContext } = await import("@/lib/context/resolver");
const { TENANT_ID, ORG_ID } = await import("@/lib/config/env");

const ctx = (): RequestContext => systemContext(TENANT_ID, ORG_ID);

let seq = 0;
/** More warehouses than any page this test asks for. */
async function manyWarehouses(n: number) {
  const qe = await getQueryEngine();
  const c = ctx();
  const run = ++seq;
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const w = await qe.create(c, "warehouse", { name: `SC${run}-${i}`, code: `SC${run}-${i}` });
    ids.push(String(w.id));
  }
  return { c, qe, ids };
}

test("filtering by id returns that record, not the first page", async () => {
  const s = await manyWarehouses(5);
  const wanted = s.ids[3];
  assert.ok(wanted);
  const page = await s.qe.list(s.c, "warehouse", {
    filters: [{ field: "id", op: "eq", value: wanted }],
    pageSize: 50,
  });
  assert.equal(page.total, 1);
  assert.equal(String(page.items[0]?.id), wanted);
});

test("listByIds resolves exactly the ids it was given", async () => {
  const s = await manyWarehouses(6);
  const wanted = [s.ids[1], s.ids[4]].filter(Boolean) as string[];
  const rows = await s.qe.listByIds(s.c, "warehouse", wanted);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => String(r.id)).sort(), [...wanted].sort());
});

test("a name lookup built on listByIds resolves the right names", async () => {
  // The shape every list route uses: read a page, then resolve its references.
  // Dropping the id filter made this return whichever rows sorted first, so the
  // Map missed and the UI fell back to showing raw ids.
  const s = await manyWarehouses(8);
  const target = s.ids[6];
  assert.ok(target);
  const rows = await s.qe.listByIds(s.c, "warehouse", [target]);
  const byId = new Map(rows.map((r) => [String(r.id), String(r.name)]));
  assert.ok(byId.get(target)?.startsWith("SC"), `expected a name, got ${String(byId.get(target))}`);
  assert.equal(byId.size, 1, "one id in, one record out");
});

test("an `in` filter over ids narrows to exactly those rows", async () => {
  const s = await manyWarehouses(5);
  const wanted = [s.ids[0], s.ids[2]].filter(Boolean) as string[];
  const page = await s.qe.list(s.c, "warehouse", {
    filters: [{ field: "id", op: "in", value: wanted }],
    pageSize: 50,
  });
  assert.equal(page.total, 2);
});

test("sorting by createdAt is honoured rather than dropped", async () => {
  // Several list routes ask for `sort: [{ field: "createdAt", dir: "desc" }]`.
  // It was being discarded, so "most recent first" was whatever order the
  // database returned.
  const s = await manyWarehouses(4);
  const page = await s.qe.list(s.c, "warehouse", {
    filters: [{ field: "id", op: "in", value: s.ids }],
    sort: [{ field: "id", dir: "desc" }],
    pageSize: 50,
  });
  const ids = page.items.map((r) => Number(r.id));
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a), "descending, as asked");
});

test("tenant scoping is not something a caller can filter on", async () => {
  // `tenantId`/`orgId` are applied by the repository from the request context.
  // A caller-supplied filter on them has no legitimate use, so they stay out of
  // the whitelist and such a filter is dropped — which is the safe direction:
  // the scope the repository adds still applies.
  const s = await manyWarehouses(3);
  const page = await s.qe.list(s.c, "warehouse", {
    filters: [
      { field: "id", op: "in", value: s.ids },
      { field: "tenantId", op: "eq", value: "some-other-tenant" },
    ],
    pageSize: 50,
  });
  assert.equal(page.total, 3, "the bogus scope filter is ignored, not obeyed");
});
