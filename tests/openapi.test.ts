/**
 * The generated contract, and the map it depends on.
 *
 * `ROUTE_DOCS` says which zod schema validates which route. That is
 * duplicated information — the handler already names the schema — and
 * duplicated information rots. This reads the route modules and fails when the
 * map and the handlers disagree, which is what makes the duplication safe.
 *
 * A stale entry is not a cosmetic problem: the whole point of generating the
 * document is that a client built from it works. A contract that describes the
 * body a route USED to accept fails at runtime with the spec insisting it
 * should have succeeded — strictly worse than having no document.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const { ROUTE_DOCS } = await import("@/lib/openapi/route-docs");
const { buildOpenApiDocument } = await import("@/lib/openapi/generate");
const { metadata } = await import("@/lib/metadata");

const ROUTES_DIR = join(process.cwd(), "src/http/routes");

/**
 * Read the route modules and pair every registration with the schemas its
 * handler validates with.
 *
 * A handler's body is taken as the text up to the next registration, which is
 * exact for this codebase because handlers are registered one after another and
 * never nested.
 */
function scanRoutes(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts") && f !== "shared.ts")) {
    const src = readFileSync(join(ROUTES_DIR, file), "utf8");
    const hits = [...src.matchAll(/\br\.(get|post|put|patch|delete)\(\s*\n?\s*"([^"]+)"/g)];
    hits.forEach((m, i) => {
      const body = src.slice(m.index, hits[i + 1]?.index ?? src.length);
      // Every route, with the schemas it validates with — an empty array for the
      // ones that take no body. Collecting only the routes WITH a body is what
      // let 101 of 163 endpoints stay undocumented without anything noticing.
      const schemas = [
        ...new Set(
          [...body.matchAll(/parseBody\(\s*req\s*,\s*(\w+)/g)]
            .map((s) => s[1])
            .filter((s): s is string => s !== undefined),
        ),
      ].sort();
      found.set(`${(m[1] ?? "").toUpperCase()} ${m[2] ?? ""}`, schemas);
    });
  }
  return found;
}

/** The generic entity CRUD routes, which are generated from metadata instead. */
const isGenericCrud = (route: string): boolean => route.includes(" /entities/:entity");

test("the scanner finds routes at all", () => {
  // Without this, every assertion below passes vacuously the day the scan
  // pattern stops matching — a guard that silently guards nothing.
  const scanned = scanRoutes();
  assert.ok(scanned.size > 150, `expected the scan to find the whole route table, found ${scanned.size}`);
});

test("every route is documented", () => {
  // The strong invariant, and the reason the map covers bodyless routes too: an
  // endpoint cannot be added without a line describing it. Documenting only the
  // routes that parse a body left two thirds of the API absent from its own
  // contract, and absent is indistinguishable from "does not exist" to anyone
  // reading the document.
  const missing = [...scanRoutes()]
    .map(([route]) => route)
    .filter((route) => !ROUTE_DOCS[route] && !isGenericCrud(route));
  assert.deepEqual(missing, []);
});

test("a route with a body declares its schema, and one without does not", () => {
  const wrong: string[] = [];
  for (const [route, schemas] of scanRoutes()) {
    if (isGenericCrud(route)) continue;
    const doc = ROUTE_DOCS[route];
    if (!doc) continue; // covered by the test above
    if (schemas.length && !doc.schema) wrong.push(`${route} validates with ${schemas.join(" + ")} but declares no schema`);
    // The reverse matters just as much: a documented body on a route that never
    // reads one makes a generated client send a payload into the void.
    if (!schemas.length && doc.schema) wrong.push(`${route} declares a request body but never parses one`);
  }
  assert.deepEqual(wrong, []);
});

test("the map has no entry for a route that no longer exists", () => {
  const scanned = scanRoutes();
  const stale = Object.keys(ROUTE_DOCS).filter((k) => !scanned.has(k));
  assert.deepEqual(stale, []);
});

test("every mapped schema is the one the handler names", async () => {
  // The check the test above cannot make from the schema object alone: compare
  // the IDENTIFIER the handler passes with the identifier this map imports.
  const mapSrc = readFileSync(join(process.cwd(), "src/lib/openapi/route-docs.ts"), "utf8");
  const declared = new Map(
    [...mapSrc.matchAll(/"((?:GET|POST|PUT|PATCH|DELETE) [^"]+)":\s*\{[^}]*?schema:\s*(\w+)/g)].map((m) => [m[1], m[2]]),
  );
  const mismatched: string[] = [];
  for (const [route, schemas] of scanRoutes()) {
    const named = declared.get(route);
    if (named && !schemas.includes(named)) {
      mismatched.push(`${route}: map says ${named}, handler validates with ${schemas.join(" + ")}`);
    }
  }
  assert.deepEqual(mismatched, []);
});

test("every operation carries a summary", () => {
  // Without one, an endpoint list renders as a column of bare paths. The entity
  // operations get theirs from metadata labels; the bespoke ones are written by
  // hand in ROUTE_DOCS, which is exactly the sort of field that gets forgotten
  // when a route is added.
  const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, { summary?: string }>> };
  const bare: string[] = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      if (!op.summary) bare.push(`${method.toUpperCase()} ${path}`);
    }
  }
  assert.deepEqual(bare, []);
});

test("operationIds are unique", () => {
  // A duplicate is not a style problem: a generated client ends up with two
  // methods of one name, and which one survives is the generator's choice.
  // Entity `posSession` and the bespoke `GET /pos/session` both produced
  // `getPosSession` — the build now throws, so this asserts the document that
  // came out rather than trusting the throw.
  const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, { operationId?: string }>> };
  const seen = new Map<string, string[]>();
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      if (!op.operationId) continue;
      seen.set(op.operationId, [...(seen.get(op.operationId) ?? []), `${method.toUpperCase()} ${path}`]);
    }
  }
  assert.deepEqual([...seen].filter(([, routes]) => routes.length > 1), []);
});

test("the document is well-formed OpenAPI 3.1", () => {
  const doc = buildOpenApiDocument() as {
    openapi: string;
    paths: Record<string, Record<string, unknown>>;
    components: { schemas: Record<string, unknown> };
  };
  assert.equal(doc.openapi, "3.1.0");
  assert.ok(Object.keys(doc.paths).length > 100, "expected a path for every entity plus the bespoke routes");
  for (const path of Object.keys(doc.paths)) {
    assert.ok(!path.includes(":"), `${path} still carries an Express parameter; OpenAPI wants {braces}`);
    assert.ok(path.startsWith("/"), `${path} is not rooted`);
  }
});

test("every $ref resolves", () => {
  // A dangling $ref is the failure mode of a generated document: it validates
  // as JSON, renders in a viewer, and breaks whatever tries to generate a
  // client from it.
  const doc = buildOpenApiDocument();
  const components = doc.components as Record<string, Record<string, unknown>>;
  const dangling = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") {
        // Resolve against whichever component bucket the ref names, so a
        // response ref is checked as strictly as a schema ref.
        const [, , bucket, name] = v.split("/");
        if (!components[bucket!]?.[name!]) dangling.add(v);
      } else walk(v);
    }
  };
  walk(doc);
  assert.deepEqual([...dangling], []);
});

test("every entity gets a documented CRUD surface", () => {
  const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, unknown>> };
  const missing: string[] = [];
  for (const e of metadata.listEntities()) {
    const list = doc.paths[`/entities/${e.name}`];
    const one = doc.paths[`/entities/${e.name}/{id}`];
    if (!list?.get || !list?.post) missing.push(`${e.name}: list/create`);
    if (!one?.get || !one?.patch || !one?.delete) missing.push(`${e.name}: read/update/delete`);
    // A lifecycle entity that does not document its transitions is the case
    // worth catching: `POST /entities/invoice/{id}/transitions` is how an
    // invoice is sent, and nothing else in the document reveals it exists.
    if (e.lifecycle && !doc.paths[`/entities/${e.name}/{id}/transitions`]) missing.push(`${e.name}: transitions`);
  }
  assert.deepEqual(missing, []);
});

test("computed fields are absent from write bodies", () => {
  // An invoice's `total` is derived from its lines. Documenting it as writable
  // makes a generated client send a value the server discards, and the caller
  // has no way to learn that from the response.
  const doc = buildOpenApiDocument() as { components: { schemas: Record<string, { properties?: Record<string, unknown> }> } };
  const leaked: string[] = [];
  for (const e of metadata.listEntities()) {
    const Name = e.name.charAt(0).toUpperCase() + e.name.slice(1);
    const create = doc.components.schemas[`${Name}Create`];
    for (const f of e.fields) {
      if ((f.computed || f.readOnly) && create?.properties?.[f.name]) leaked.push(`${e.name}.${f.name}`);
    }
  }
  assert.deepEqual(leaked, []);
});
