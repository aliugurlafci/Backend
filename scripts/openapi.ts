/**
 * Write the OpenAPI document to disk (`npm run openapi`).
 *
 * The server serves the same document at `GET /api/v1/openapi.json`, but a file
 * is what a client generator, a diff in review, and CI all want — a spec change
 * should be visible as a changed file, not as something you have to boot the
 * application to observe.
 *
 * No database: the document comes from entity metadata and the request schemas,
 * both of which are compiled in. That is deliberate — generating a contract must
 * not depend on a running system, or it cannot run in CI.
 */
process.env.AULA_PERSISTENCE = process.env.AULA_PERSISTENCE ?? "memory";

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const { buildOpenApiDocument } = await import("@/lib/openapi/generate");

const out = resolve(process.argv[2] ?? "openapi.json");
const doc = buildOpenApiDocument();
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");

const paths = Object.keys(doc.paths as Record<string, unknown>).length;
const schemas = Object.keys((doc.components as { schemas: Record<string, unknown> }).schemas).length;
const operations = Object.values(doc.paths as Record<string, Record<string, unknown>>)
  .reduce((n, ops) => n + Object.keys(ops).length, 0);
console.log(`wrote ${out} — ${paths} paths, ${operations} operations, ${schemas} schemas`);
