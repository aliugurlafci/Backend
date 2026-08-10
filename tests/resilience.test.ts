/**
 * Unit checks for the load-shedding + request-timeout middleware. Fast in-memory
 * handlers never let in-flight pile up enough to trip the guard in a live smoke
 * run, so we drive the middleware directly with a tiny cap: the (cap+1)th
 * concurrent request must be shed with 503 OVERLOADED, and a request that never
 * responds must be timed out with 503 TIMEOUT. Env is set before the dynamic
 * import so the module reads the low thresholds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AULA_MAX_INFLIGHT = "2";
process.env.AULA_REQUEST_TIMEOUT_MS = "1000";

const { resilience, getInflight } = await import("@/lib/http/resilience");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface MockRes {
  headersSent: boolean;
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  listeners: Record<string, () => void>;
  setHeader: (k: string, v: string) => void;
  status: (c: number) => MockRes;
  json: (b: unknown) => MockRes;
  on: (ev: string, cb: () => void) => void;
  finish: () => void;
}
function mkRes(): MockRes {
  const res = {
    headersSent: false,
    statusCode: 0,
    body: null,
    headers: {},
    listeners: {},
  } as MockRes;
  res.setHeader = (k, v) => {
    res.headers[k] = v;
  };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    res.headersSent = true;
    return res;
  };
  res.on = (ev, cb) => {
    res.listeners[ev] = cb;
  };
  res.finish = () => res.listeners.finish?.();
  return res;
}

test("sheds the request beyond the in-flight cap with 503 OVERLOADED", () => {
  const mw = resilience();
  const call = () => {
    const res = mkRes();
    let passed = false;
    mw({} as never, res as never, () => {
      passed = true;
    });
    return { res, passed: () => passed };
  };

  const a = call();
  const b = call();
  assert.equal(a.passed(), true);
  assert.equal(b.passed(), true);
  assert.equal(getInflight(), 2);

  // Third exceeds the cap of 2 → shed, next() not called.
  const c = call();
  assert.equal(c.passed(), false);
  assert.equal(c.res.statusCode, 503);
  assert.deepEqual((c.res.body as { error: { code: string } }).error.code, "OVERLOADED");

  // Finishing one frees a slot; the next request passes through.
  a.res.finish();
  assert.equal(getInflight(), 1);
  const d = call();
  assert.equal(d.passed(), true);

  // Clean up the counter for the next test.
  b.res.finish();
  d.res.finish();
  assert.equal(getInflight(), 0);
});

test("times out a stuck request with 503 TIMEOUT", async () => {
  const mw = resilience();
  const res = mkRes();
  mw({} as never, res as never, () => {
    /* handler never responds */
  });
  assert.equal(getInflight(), 1);
  await delay(1200); // exceed the 1000ms budget
  assert.equal(res.statusCode, 503);
  assert.deepEqual((res.body as { error: { code: string } }).error.code, "TIMEOUT");
  res.finish(); // real Express fires 'finish' after the response; release the slot
  assert.equal(getInflight(), 0);
});
