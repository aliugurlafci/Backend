/**
 * HTTP-level tests for the edge rate limiter.
 *
 * These boot the real Express app and talk to it over a socket, because the
 * thing under test is the MIDDLEWARE ORDER, and that only exists once the app is
 * assembled. A unit test of the limiter would pass while the bug was live: the
 * bug was never in the counting, it was that authentication threw before the
 * counter was reached.
 *
 * `AULA_PERSISTENCE=memory` is set before the app is imported so nothing here
 * needs a database — env.ts reads process.env at module load.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";
process.env.AULA_TRUST_PROXY = "0";
process.env.AULA_EDGE_RATE_LIMIT = "25";

import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const { createApp } = await import("@/http/server");

/** Start the app on an ephemeral port and return its base URL plus a stopper. */
async function serve(): Promise<{ url: string; stop: () => Promise<void> }> {
  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("an unauthenticated flood is capped, not answered 401 forever", async () => {
  const { url, stop } = await serve();
  try {
    const statuses: number[] = [];
    // Comfortably past the configured limit of 25.
    for (let i = 0; i < 40; i++) {
      const res = await fetch(`${url}/api/v1/auth/me`);
      statuses.push(res.status);
    }

    // The point of the fix: these requests never reached the per-principal
    // limiter, because resolveContext() throws UnauthenticatedError first.
    assert.ok(
      statuses.includes(401),
      "expected the early requests to be rejected as unauthenticated",
    );
    assert.ok(
      statuses.includes(429),
      "unauthenticated requests must eventually be rate limited — before this fix they returned 401 indefinitely",
    );
    // Once the window is exhausted it stays exhausted.
    assert.equal(statuses.at(-1), 429);
  } finally {
    await stop();
  }
});

test("the 429 body uses the same error envelope as every other failure", async () => {
  const { url, stop } = await serve();
  try {
    let body: unknown = null;
    for (let i = 0; i < 40; i++) {
      const res = await fetch(`${url}/api/v1/auth/me`);
      if (res.status === 429) {
        body = await res.json();
        break;
      }
    }
    assert.deepEqual(body, {
      error: { code: "RATE_LIMITED", message: "too many requests from this address; slow down and retry" },
    });
  } finally {
    await stop();
  }
});

test("X-Forwarded-For cannot buy a fresh budget when the proxy is untrusted", async () => {
  const { url, stop } = await serve();
  try {
    // Every request claims a different origin address. With `trust proxy` left
    // at `true` this rotated the limiter key and the cap never applied; with the
    // hop count configured, req.ip stays the real socket address.
    let limited = false;
    for (let i = 0; i < 40; i++) {
      const res = await fetch(`${url}/api/v1/auth/me`, {
        headers: { "x-forwarded-for": `203.0.113.${i}` },
      });
      if (res.status === 429) {
        limited = true;
        break;
      }
    }
    assert.ok(limited, "a spoofed X-Forwarded-For must not reset the per-IP counter");
  } finally {
    await stop();
  }
});

test("the liveness probe is exempt, so a flood cannot trigger a restart loop", async () => {
  const { url, stop } = await serve();
  try {
    // Exhaust the budget first.
    for (let i = 0; i < 40; i++) await fetch(`${url}/api/v1/auth/me`);
    const res = await fetch(`${url}/api/v1/health`);
    assert.notEqual(res.status, 429, "the orchestrator's probe cannot back off; limiting it is self-inflicted downtime");
  } finally {
    await stop();
  }
});

test("the response carries an API content-security policy, not a web-app one", async () => {
  // Pinned because the difference is invisible: helmet ships a default that
  // permits scripts, inline styles and same-origin framing — sensible for a page
  // that serves HTML, wrong for a service that returns JSON and file bytes. The
  // policy is also the last line behind the upload MIME checks, so a later
  // "let's relax this for the web app" would quietly remove it.
  const { url, stop } = await serve();
  try {
    const res = await fetch(`${url}/api/v1/health`);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /form-action 'none'/);
    // Nothing may execute or load. `script-src` falls back to default-src, so
    // its ABSENCE is the assertion — a permissive one would appear here.
    assert.ok(!/script-src 'self'/.test(csp), `script-src must not be widened: ${csp}`);
    assert.ok(!/'unsafe-inline'/.test(csp), `inline content must stay disallowed: ${csp}`);

    // Framing is denied twice on purpose: the modern directive and the legacy
    // header, because they are honoured by different browsers.
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  } finally {
    await stop();
  }
});
