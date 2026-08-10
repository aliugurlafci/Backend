/**
 * Query-string filter parsing.
 *
 * The risk in widening this syntax is not that the new operators fail — it is
 * that the old form quietly changes meaning. `filter.x=1` has to keep producing
 * exactly what it produced before, and a field name containing a dot must not
 * start being read as an operator. Both are silent failures: the request
 * succeeds and returns confidently wrong rows.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import { parseListQuery } from "@/lib/http/handler";

/** The parser reads `req.originalUrl`, so that is all a fake request needs. */
const req = (url: string): Request => ({ originalUrl: url }) as Request;

test("a bare filter is still equality", () => {
  assert.deepEqual(parseListQuery(req("/x?filter.status=open")).filters, [
    { field: "status", op: "eq", value: "open" },
  ]);
});

test("a named operator is honoured", () => {
  assert.deepEqual(parseListQuery(req("/x?filter.total.gte=1000")).filters, [
    { field: "total", op: "gte", value: 1000 },
  ]);
  assert.deepEqual(parseListQuery(req("/x?filter.name.contains=vida")).filters, [
    { field: "name", op: "contains", value: "vida" },
  ]);
});

test("`in` takes a comma-separated set", () => {
  assert.deepEqual(parseListQuery(req("/x?filter.status.in=open,partial,overdue")).filters, [
    { field: "status", op: "in", value: ["open", "partial", "overdue"] },
  ]);
});

test("an `in` with no members is dropped rather than matching everything", () => {
  // `value: []` reaching the repository is an empty IN, whose meaning differs by
  // engine and by construction — and "the caller filtered on nothing" is far
  // more likely to mean a broken client than "return the whole table".
  assert.equal(parseListQuery(req("/x?filter.status.in=,,")).filters, undefined);
});

test("an unrecognised trailing segment stays part of the field name", () => {
  // Not silently reinterpreted as an operator, and never falling back to `eq` on
  // a truncated field — either would query a different column than was asked
  // for and answer without complaint.
  assert.deepEqual(parseListQuery(req("/x?filter.meta.channel=sms")).filters, [
    { field: "meta.channel", op: "eq", value: "sms" },
  ]);
});

test("a date range is two filters on one field", () => {
  const q = parseListQuery(req("/x?filter.issueDate.gte=2026-01-01&filter.issueDate.lt=2027-01-01"));
  assert.deepEqual(q.filters, [
    { field: "issueDate", op: "gte", value: "2026-01-01" },
    { field: "issueDate", op: "lt", value: "2027-01-01" },
  ]);
});

test("empty values are ignored, so a cleared form field is not a filter", () => {
  assert.equal(parseListQuery(req("/x?filter.status=&filter.total.gte=")).filters, undefined);
});

test("paging and sorting are unaffected", () => {
  const q = parseListQuery(req("/x?page=2&pageSize=50&sort=total:desc&filter.status.ne=void"));
  assert.equal(q.page, 2);
  assert.equal(q.pageSize, 50);
  assert.deepEqual(q.sort, [{ field: "total", dir: "desc" }]);
  assert.deepEqual(q.filters, [{ field: "status", op: "ne", value: "void" }]);
});

test("an oversized pageSize is still refused rather than clamped", () => {
  assert.throws(() => parseListQuery(req("/x?pageSize=500")), /pageSize must be 200 or less/);
});

test("values are coerced against the entity's field types", () => {
  // `qty` is a number on stockBalance; without coercion the comparison would be
  // string-vs-number and the in-memory repository's strict === would never match.
  assert.deepEqual(parseListQuery(req("/x?filter.qty.lte=5"), "stockBalance").filters, [
    { field: "qty", op: "lte", value: 5 },
  ]);
  // An enum stays verbatim — "01" must not become 1.
  assert.deepEqual(parseListQuery(req("/x?filter.kind=reorder"), "stockAlert").filters, [
    { field: "kind", op: "eq", value: "reorder" },
  ]);
});
