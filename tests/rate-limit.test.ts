/**
 * Rate-limit bucket lifecycle.
 *
 * Keys are per principal AND per path, so on a long-lived process the map grows
 * with every route each user has ever touched. Expired buckets were never
 * removed — a slow leak with no upper bound. These pin the sweep, and the
 * counting behaviour it must not disturb.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimit, peekRateLimit, clearRateLimit, resetRateLimits, rateLimitSize } from "@/lib/security/rate-limit";

test("counts hits within the window and refuses past the limit", () => {
  resetRateLimits();
  const key = "u1:/entities/invoice";
  for (let i = 0; i < 3; i++) assert.equal(rateLimit(key, 3, 60_000).allowed, true);
  const over = rateLimit(key, 3, 60_000);
  assert.equal(over.allowed, false);
  assert.equal(over.remaining, 0);
});

test("peek reports state without consuming a hit", () => {
  resetRateLimits();
  const key = "u2:/login";
  rateLimit(key, 5, 60_000);
  const before = peekRateLimit(key, 5).remaining;
  peekRateLimit(key, 5);
  peekRateLimit(key, 5);
  assert.equal(peekRateLimit(key, 5).remaining, before, "peeking must not count");
});

test("clearing a key resets its counter (a successful login)", () => {
  resetRateLimits();
  const key = "u3:/login";
  rateLimit(key, 2, 60_000);
  rateLimit(key, 2, 60_000);
  assert.equal(rateLimit(key, 2, 60_000).allowed, false);
  clearRateLimit(key);
  assert.equal(rateLimit(key, 2, 60_000).allowed, true);
});

test("the map stays bounded instead of growing with every key ever seen", () => {
  resetRateLimits();
  // 5,000 distinct keys, each with a 1ms window — i.e. expired almost immediately.
  // Before the sweep existed every one of these stayed in the map forever.
  for (let i = 0; i < 5_000; i++) rateLimit(`stale:${i}`, 10, 1);
  const size = rateLimitSize();
  assert.ok(size < 5_000, `expected the map to be reclaimed, still holding ${size}`);
  // It settles near the sweep threshold rather than tracking total keys seen.
  assert.ok(size <= 1_100, `expected roughly the sweep threshold, got ${size}`);
});

test("the sweep never drops a live bucket", () => {
  resetRateLimits();
  for (let i = 0; i < 1_500; i++) rateLimit(`stale:${i}`, 10, 1);
  rateLimit("live", 3, 60_000);
  for (let i = 0; i < 20; i++) rateLimit("live", 3, 60_000);
  // "live" has been hit 21 times against a limit of 3 — still counted, so the
  // sweep did not silently reset it.
  assert.equal(rateLimit("live", 3, 60_000).allowed, false);
});
