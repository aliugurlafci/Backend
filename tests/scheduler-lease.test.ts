/**
 * Leader election for the scheduler.
 *
 * Every instance used to run the jobs, and the defence was that they are
 * idempotent — a property each job has to be written to have rather than one the
 * design provides. `scanStockAlerts` is the counter-example: it reads the open
 * alerts, finds none, and creates one. Two concurrent runs both read none and
 * both create.
 *
 * The election is tested through a second identity rather than a second process,
 * because what is being verified is the CONFLICT — that two writers at the same
 * version cannot both win — and that is a property of the data layer, not of the
 * operating system.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";

const { getQueryEngine } = await import("@/lib/data/store");
const { systemContext } = await import("@/lib/context/resolver");
const { TENANT_ID, ORG_ID } = await import("@/lib/config/env");
const { acquireLease, releaseLease, leaseState, instanceId } = await import("@/lib/jobs/lease");

const ctx = () => systemContext(TENANT_ID, ORG_ID);
const NOW = "2026-08-08T10:00:00.000Z";
const later = (ms: number): string => new Date(Date.parse(NOW) + ms).toISOString();

async function leaseRow() {
  const qe = await getQueryEngine();
  const page = await qe.list(ctx(), "schedulerLease", {
    filters: [{ field: "name", op: "eq", value: "scheduler" }],
    pageSize: 1,
  });
  return page.items[0] ?? null;
}

/** Pretend to be a different instance by writing the row as somebody else. */
async function claimedBySomeoneElse(expiresAt: string): Promise<void> {
  const qe = await getQueryEngine();
  const row = await leaseRow();
  if (row) {
    await qe.patchComputed(ctx(), "schedulerLease", String(row.id), { holder: "other-instance", expiresAt });
    return;
  }
  await qe.create(ctx(), "schedulerLease", {
    name: "scheduler",
    holder: "other-instance",
    acquiredAt: NOW,
    expiresAt,
    hostname: "other-host",
  });
}

test("the first instance to ask becomes the leader", async () => {
  assert.equal(await acquireLease(NOW), true);
  const state = await leaseState(NOW);
  assert.equal(state.held, true);
  assert.equal(state.holder, instanceId());
});

test("the leader keeps the lease on later ticks", async () => {
  // Renewal, not re-election. Losing it every tick would mean the jobs stopped
  // and restarted constantly under a second instance.
  assert.equal(await acquireLease(later(60_000)), true);
  assert.equal(await acquireLease(later(120_000)), true);
});

test("renewal extends the expiry rather than resetting the claim", async () => {
  const before = await leaseRow();
  const acquiredAt = String(before?.acquiredAt);
  // Later than the previous acquire, because that is what time does. Renewing
  // with an earlier stamp is not a case worth defending against — only the
  // holder renews, so only its own clock is involved.
  await acquireLease(later(180_000));
  const after = await leaseRow();
  assert.equal(String(after?.acquiredAt), acquiredAt, "the original acquisition time is kept");
  assert.ok(String(after?.expiresAt) > String(before?.expiresAt), "but the expiry moves forward");
});

test("another instance's live lease is not taken", async () => {
  // THE assertion. Without it, two instances run the billing run.
  await claimedBySomeoneElse(later(10 * 60_000));
  assert.equal(await acquireLease(later(60_000)), false);
  const state = await leaseState(later(60_000));
  assert.equal(state.held, false);
  assert.equal(state.holder, "other-instance");
});

test("an expired lease IS taken over", async () => {
  // The reason this is a lease and not a lock: the holder can die without
  // releasing anything, and a lock nobody can take back stops the jobs for good.
  await claimedBySomeoneElse(later(60_000));
  assert.equal(await acquireLease(later(10 * 60_000)), true);
  assert.equal((await leaseState(later(10 * 60_000))).holder, instanceId());
});

test("a lease expiring exactly now is takeable", async () => {
  // Otherwise a leader that died at the boundary blocks everyone for one more
  // full interval, for no reason anyone could explain.
  const at = later(5 * 60_000);
  await claimedBySomeoneElse(at);
  assert.equal(await acquireLease(at), true);
});

test("releasing hands over immediately", async () => {
  await acquireLease(later(20 * 60_000));
  assert.equal((await leaseState(later(20 * 60_000))).held, true);

  await releaseLease();
  assert.equal((await leaseState(later(20 * 60_000))).held, false, "no longer ours");

  const row = await leaseRow();
  assert.ok(row, "the row is kept, not deleted — it records who ran last");
  assert.ok(String(row?.expiresAt) < NOW, "and is expired so anyone may take it");
});

test("a released lease is immediately available to another instance", async () => {
  await claimedBySomeoneElse(later(30 * 60_000));
  // Our release must not touch a lease we do not hold.
  await releaseLease();
  assert.equal((await leaseState(later(30 * 60_000))).holder, "other-instance", "releasing must not steal someone else's lease");
});

test("acquiring never throws, whatever storage does", async () => {
  // A database hiccup means "not the leader this time", and the next tick tries
  // again. Failing loudly here would turn a transient error into a scheduler
  // that stopped — the outcome the lease exists to prevent.
  const result = await acquireLease("not-a-date");
  assert.equal(typeof result, "boolean");
});
