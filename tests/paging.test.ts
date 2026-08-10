/**
 * The paging contract.
 *
 * A clamped page size is the most damaging bug this codebase has had: asking for
 * 500 rows and receiving 200 with no error meant exports, dashboards, aging
 * reports — and, worse, the lines of documents being posted to the ledger — were
 * computed from a silent subset. These tests pin the two halves of the fix:
 *
 *  - external callers are REJECTED above MAX_PAGE_SIZE, never trimmed;
 *  - internal callers may raise the ceiling explicitly, up to a hard backstop.
 *
 * Pure functions only — no database, no HTTP listener.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import {
  DEFAULT_PAGE_SIZE,
  INTERNAL_MAX_PAGE_SIZE,
  MAX_PAGE_SIZE,
  normalizePaging,
} from "@/lib/data/query";
import { parseListQuery } from "@/lib/http/handler";
import { BadRequestError } from "@/lib/enforcement/errors";

// ---- normalizePaging -------------------------------------------------------

test("defaults to page 1 and DEFAULT_PAGE_SIZE", () => {
  assert.deepEqual(normalizePaging({}), { page: 1, pageSize: DEFAULT_PAGE_SIZE });
});

test("clamps to MAX_PAGE_SIZE when no explicit ceiling is given", () => {
  // Still a clamp at this layer — the rejection happens at the HTTP edge, so a
  // service passing an oversized value by mistake degrades rather than throws.
  assert.equal(normalizePaging({ pageSize: 5_000 }).pageSize, MAX_PAGE_SIZE);
});

test("an internal caller can raise the ceiling above MAX_PAGE_SIZE", () => {
  assert.equal(normalizePaging({ pageSize: 1_000 }, { max: 2_000 }).pageSize, 1_000);
});

test("the raised ceiling is itself capped at INTERNAL_MAX_PAGE_SIZE", () => {
  // Nobody gets to ask for an unbounded page, however deliberately.
  assert.equal(
    normalizePaging({ pageSize: 10_000_000 }, { max: Number.MAX_SAFE_INTEGER }).pageSize,
    INTERNAL_MAX_PAGE_SIZE,
  );
});

test("page and pageSize are floored to at least 1", () => {
  assert.deepEqual(normalizePaging({ page: 0, pageSize: 0 }), { page: 1, pageSize: 1 });
  assert.deepEqual(normalizePaging({ page: -3, pageSize: -7 }), { page: 1, pageSize: 1 });
});

test("fractional input is floored, not rounded", () => {
  assert.deepEqual(normalizePaging({ page: 2.9, pageSize: 10.9 }), { page: 2, pageSize: 10 });
});

// ---- parseListQuery --------------------------------------------------------

/** `parseListQuery` re-parses the raw query string, so that is all it needs. */
function req(url: string): Request {
  return { originalUrl: url } as Request;
}

test("accepts a pageSize at exactly the cap", () => {
  assert.equal(parseListQuery(req(`/entities/invoice?pageSize=${MAX_PAGE_SIZE}`)).pageSize, MAX_PAGE_SIZE);
});

test("REJECTS a pageSize above the cap instead of clamping it", () => {
  assert.throws(
    () => parseListQuery(req("/entities/invoice?pageSize=500")),
    (err: unknown) => {
      assert.ok(err instanceof BadRequestError, "should be a 400, not a silent trim");
      assert.match((err as Error).message, /pageSize must be 200 or less/);
      return true;
    },
  );
});

test("a non-numeric pageSize is not treated as over-cap", () => {
  // NaN is not > MAX_PAGE_SIZE; normalizePaging falls back to the default later.
  assert.doesNotThrow(() => parseListQuery(req("/entities/invoice?pageSize=abc")));
});

test("omitting pageSize leaves it unset for the default to apply", () => {
  assert.equal(parseListQuery(req("/entities/invoice")).pageSize, undefined);
});

test("page, sort and filters survive the pageSize guard", () => {
  const q = parseListQuery(req("/entities/invoice?page=3&pageSize=50&sort=number:desc&filter.status=sent"));
  assert.equal(q.page, 3);
  assert.equal(q.pageSize, 50);
  assert.deepEqual(q.sort, [{ field: "number", dir: "desc" }]);
  assert.deepEqual(q.filters, [{ field: "status", op: "eq", value: "sent" }]);
});
