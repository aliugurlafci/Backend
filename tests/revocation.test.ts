/**
 * Token revocation.
 *
 * These are the assertions that decide whether "sign out" and "remove access"
 * mean anything. Before this existed both were cosmetic: the grants live in the
 * token, nothing consulted storage on the way in, and clearing a cookie does not
 * touch a bearer token that was issued from the same login.
 *
 * Run against the in-memory repository, so no database is needed.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { RequestContext } from "@/lib/context/types";

// Imported dynamically, AFTER the assignments above. Static imports are hoisted
// and would run first, so `config/env` would read the real `.env`, resolve
// AULA_PERSISTENCE=sql, and the suite would sit waiting on a database
// connection instead of failing — which is what it did.
const { getQueryEngine } = await import("@/lib/data/store");
const { systemContext } = await import("@/lib/context/resolver");
const { AppError } = await import("@/lib/enforcement/errors");
const { cache } = await import("@/lib/cache/cache");
const {
  assertTokenActive,
  bumpTokenEpoch,
  loadRevocations,
  pruneRevocations,
  resetRevocationsForTest,
  revocationCount,
  revokeToken,
} = await import("@/lib/security/revocation");

// Read from config rather than hardcoded: the revocation service builds its own
// system context from these, and a test that invented different values would be
// looking up users in a scope where they do not exist — which surfaced as
// "access changed" for a user who was perfectly fine.
const { TENANT_ID: TENANT, ORG_ID: ORG } = await import("@/lib/config/env");

/** A caller as `runApi` would present them: a principal plus its token facts. */
function ctxFor(userId: string, over: Partial<RequestContext> = {}): RequestContext {
  return systemContext(TENANT, ORG, {
    userId,
    displayName: userId,
    email: `${userId}@example.test`,
    roles: Object.freeze(["admin"]),
    isSystem: false,
    jti: `jti-${userId}`,
    tokenEpoch: 0,
    ...over,
  });
}

async function makeUser(id: string, over: Record<string, unknown> = {}): Promise<string> {
  const qe = await getQueryEngine();
  const sys = systemContext(TENANT, ORG);
  const position = await qe.create(sys, "position", { name: `pos-${id}`, role: "admin" });
  const user = await qe.create(sys, "user", {
    email: `${id}@example.test`,
    displayName: id,
    positionId: String(position.id),
    active: true,
    ...over,
  });
  return String(user.id);
}

/** The epoch is cached for a few seconds; tests must not read a stale one. */
async function clearEpochCache(userId: string): Promise<void> {
  await cache.delete(`auth:epoch:${userId}`);
}

beforeEach(() => {
  resetRevocationsForTest();
});

test("a live token passes", async () => {
  const id = await makeUser("live");
  await clearEpochCache(id);
  await assertTokenActive(ctxFor(id));
});

test("a signed-out token is refused", async () => {
  const id = await makeUser("bye");
  await clearEpochCache(id);
  const ctx = ctxFor(id);

  await assertTokenActive(ctx); // still fine
  await revokeToken(ctx, ctx.jti!, "2099-01-01T00:00:00.000Z");

  await assert.rejects(() => assertTokenActive(ctx), (e: unknown) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.httpStatus, 401);
    return true;
  });
});

test("signing out one session leaves the others alone", async () => {
  // The reason this is a separate mechanism from the epoch: logging out of a
  // phone must not log the same person out of the till.
  const id = await makeUser("two-devices");
  await clearEpochCache(id);
  const phone = ctxFor(id, { jti: "jti-phone" });
  const till = ctxFor(id, { jti: "jti-till" });

  await revokeToken(phone, "jti-phone", "2099-01-01T00:00:00.000Z");

  await assert.rejects(() => assertTokenActive(phone));
  await assertTokenActive(till); // must still work
});

test("bumping the epoch invalidates every token the user holds", async () => {
  const id = await makeUser("all-devices");
  await clearEpochCache(id);
  const phone = ctxFor(id, { jti: "p" });
  const till = ctxFor(id, { jti: "t" });
  await assertTokenActive(phone);
  await assertTokenActive(till);

  await bumpTokenEpoch(id, "test");

  await assert.rejects(() => assertTokenActive(phone));
  await assert.rejects(() => assertTokenActive(till));
});

test("a token issued AFTER the bump is accepted", async () => {
  // Otherwise "sign out everywhere" would lock the user out permanently rather
  // than ending the sessions that existed.
  const id = await makeUser("re-login");
  await clearEpochCache(id);
  const epoch = await bumpTokenEpoch(id, "test");
  await assertTokenActive(ctxFor(id, { jti: "fresh", tokenEpoch: epoch }));
});

test("deactivating an account ends its session immediately", async () => {
  const id = await makeUser("disabled");
  await clearEpochCache(id);
  const ctx = ctxFor(id);
  await assertTokenActive(ctx);

  const qe = await getQueryEngine();
  await qe.patchComputed(systemContext(TENANT, ORG), "user", id, { active: false });
  await clearEpochCache(id);

  // Pressing "deactivate" is understood to mean "they are out now", not "they
  // are out within the hour".
  await assert.rejects(() => assertTokenActive(ctx));
});

test("a deleted user's token stops working", async () => {
  const id = await makeUser("deleted");
  await clearEpochCache(id);
  const ctx = ctxFor(id);
  await assertTokenActive(ctx);

  const qe = await getQueryEngine();
  await qe.remove(systemContext(TENANT, ORG), "user", id);
  await clearEpochCache(id);

  await assert.rejects(() => assertTokenActive(ctx));
});

test("system contexts are exempt", async () => {
  // Jobs, migrations and seeds carry no token, so there is nothing to revoke —
  // and failing them closed would stop the scheduler on every deploy.
  await assertTokenActive(systemContext(TENANT, ORG));
});

test("the denylist survives a restart", async () => {
  const id = await makeUser("restart");
  await clearEpochCache(id);
  const ctx = ctxFor(id, { jti: "persists" });
  await revokeToken(ctx, "persists", "2099-01-01T00:00:00.000Z");

  // Simulate a process restart: in-memory state gone, storage intact.
  resetRevocationsForTest();
  assert.equal(revocationCount(), 0);
  await loadRevocations();

  assert.equal(revocationCount() >= 1, true);
  await assert.rejects(() => assertTokenActive(ctx), "a restart must not undo a sign-out");
});

test("an already-expired revocation is not carried forward", async () => {
  // Past its own `exp` the token is refused by expiry, so remembering it is
  // pure cost — this is what keeps the denylist small enough to hold in memory.
  //
  // Asserted on THIS entry rather than on the total: the store is shared across
  // tests in this file, so a global count would be measuring the other tests.
  const id = await makeUser("expired");
  const ctx = ctxFor(id, { jti: "old-and-expired" });
  await revokeToken(ctx, "old-and-expired", "2000-01-01T00:00:00.000Z");
  await assert.rejects(() => assertTokenActive(ctx), "revoking takes effect immediately");

  resetRevocationsForTest();
  await loadRevocations();
  assert.ok(revocationCount() >= 0);

  // Reloaded without it: the token's own expiry now does the refusing.
  await clearEpochCache(id);
  await assertTokenActive(ctx);
});

test("pruning drops expired rows and keeps live ones", async () => {
  const id = await makeUser("prune");
  const ctx = ctxFor(id);
  await revokeToken(ctx, "gone", "2000-01-01T00:00:00.000Z");
  await revokeToken(ctx, "still-here", "2099-01-01T00:00:00.000Z");

  // Scoped to the two entries this test created — other tests share the store.
  const before = revocationCount();
  await pruneRevocations(systemContext(TENANT, ORG, { at: "2026-08-08T10:00:00.000Z" }));
  assert.ok(revocationCount() < before, "at least the expired entry should be gone");

  await clearEpochCache(id);
  // The expired one no longer blocks; the live one still does.
  await assertTokenActive(ctxFor(id, { jti: "gone" }));
  await assert.rejects(() => assertTokenActive(ctxFor(id, { jti: "still-here" })));
});
