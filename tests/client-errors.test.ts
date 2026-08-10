/**
 * Crash reports from the app.
 *
 * The app already caught everything — a boundary, a global handler, a ring
 * buffer the settings screen could show. What it could not do is tell anybody:
 * a till that crashed left a trace only on that device, and the only account of
 * what happened was whatever the person standing at it remembered.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import type { RequestContext } from "@/lib/context/types";

const { getQueryEngine } = await import("@/lib/data/store");
const { systemContext } = await import("@/lib/context/resolver");
const { TENANT_ID, ORG_ID } = await import("@/lib/config/env");
const { createHash } = await import("node:crypto");

const ctx = (): RequestContext => systemContext(TENANT_ID, ORG_ID);

/** The same fingerprint the route computes. */
const fingerprintOf = (message: string, stack = "") =>
  createHash("sha256")
    .update(`${message}|${stack.split("\n").slice(0, 2).join(" ").slice(0, 200)}`)
    .digest("hex")
    .slice(0, 32);

const store = async (e: Record<string, unknown>) => {
  const qe = await getQueryEngine();
  return qe.create(ctx(), "clientError", {
    fingerprint: fingerprintOf(String(e.message), String(e.stack ?? "")),
    severity: "handled",
    occurredAt: "2026-08-09T10:00:00.000Z",
    ...e,
  });
};

test("the same failure on twenty tills groups into one problem", async () => {
  // A list that shows it twenty times buries the other three. The count is the
  // point, so the fingerprint is deliberately NOT unique.
  const stack = "TypeError: undefined is not an object\n  at CartScreen (cart.tsx:42)";
  for (let i = 0; i < 3; i++) {
    await store({ message: "undefined is not an object", stack, deviceName: `Kasa ${i}` });
  }
  const qe = await getQueryEngine();
  const rows = await qe.listComplete(ctx(), "clientError", {
    filters: [{ field: "fingerprint", op: "eq", value: fingerprintOf("undefined is not an object", stack) }],
  });
  assert.equal(rows.length, 3, "three reports");
  assert.equal(new Set(rows.map((r) => r.fingerprint)).size, 1, "one problem");
});

test("different failures do not group together", async () => {
  const a = fingerprintOf("network request failed", "at sync.ts:10");
  const b = fingerprintOf("database is locked", "at db.ts:88");
  assert.notEqual(a, b);
});

test("the same message from different places is a different problem", async () => {
  // "Network request failed" in the sync engine and in the label printer are not
  // the same bug, and grouping on the message alone would merge them.
  const a = fingerprintOf("Network request failed", "at syncEngine (engine.ts:120)");
  const b = fingerprintOf("Network request failed", "at printLabel (labels.tsx:44)");
  assert.notEqual(a, b);
});

test("a report carries when it happened on the DEVICE", async () => {
  // A fatal crash is reported on the next launch — possibly the next morning.
  // Ordering by arrival would file it under the wrong shift entirely.
  const row = await store({
    message: "app closed unexpectedly",
    severity: "fatal",
    occurredAt: "2026-08-08T22:15:00.000Z",
    appVersion: "1.4.0",
  });
  assert.equal(String(row.occurredAt), "2026-08-08T22:15:00.000Z");
  assert.notEqual(String(row.createdAt).slice(0, 10), "2026-08-08", "arrived later than it happened");
});

test("fatal and handled are distinguishable", async () => {
  // One means somebody lost work; the other means the app coped. A list that
  // cannot tell them apart is a list nobody triages.
  await store({ message: "recovered", severity: "handled" });
  await store({ message: "crashed", severity: "fatal" });
  const qe = await getQueryEngine();
  const fatal = await qe.listComplete(ctx(), "clientError", {
    filters: [{ field: "severity", op: "eq", value: "fatal" }],
  });
  assert.ok(fatal.length >= 1);
  assert.ok(fatal.every((r) => r.severity === "fatal"));
});

test("the app version is recorded", async () => {
  // The first question about any crash, and the one nobody thinks to record.
  const row = await store({ message: "boom", appVersion: "2.1.0", platform: "android" });
  assert.equal(String(row.appVersion), "2.1.0");
  assert.equal(String(row.platform), "android");
});
