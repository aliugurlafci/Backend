/**
 * Leader election for the in-process scheduler.
 *
 * One instance runs the jobs; the others wait. The election is a LEASE rather
 * than a lock, because the holder can die without releasing anything and a lock
 * nobody can take back is worse than none — it would stop the jobs running at
 * all. A lease expires on its own, so a crashed instance costs one interval of
 * delay.
 *
 * The atomicity comes from optimistic concurrency, which the data layer already
 * enforces: two instances that read the same lease row both try to update it at
 * the version they read, and exactly one succeeds. The loser gets a conflict,
 * which is the correct answer to "did I win the election?" — no additional
 * locking primitive, and it behaves identically on both SQL engines.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import { systemContext } from "@/lib/context/resolver";
import { logger } from "@/lib/observability/logger";
import { TENANT_ID, ORG_ID } from "@/lib/config/env";

const LEASE_NAME = "scheduler";

/**
 * Identity of THIS run, not this host.
 *
 * A hostname would be wrong on a machine running two instances, and stable
 * across a restart — so a process that crashed and came back would look like it
 * still held its own lease and skip the takeover it needs.
 */
const INSTANCE_ID = randomUUID();

/**
 * How long a claim survives without renewal.
 *
 * The window during which a crashed leader blocks the others. Long enough that a
 * slow tick does not lose the lease mid-job, short enough that nobody waits
 * minutes for jobs to resume. Renewal happens every tick, so under normal
 * operation it is refreshed several times over within one lease.
 */
const LEASE_MS = 3 * 60_000;

function sys(): RequestContext {
  return systemContext(TENANT_ID, ORG_ID);
}

export interface LeaseState {
  held: boolean;
  holder: string | null;
  expiresAt: string | null;
}

/**
 * Try to become (or stay) the leader.
 *
 * Returns whether this instance may run jobs on this tick. Never throws: a
 * database hiccup means "not the leader this time", and the next tick tries
 * again. Failing loudly here would turn a transient error into a stopped
 * scheduler, which is the outcome the lease exists to prevent.
 */
export async function acquireLease(nowIso: string): Promise<boolean> {
  try {
    const qe = await getQueryEngine();
    const ctx = sys();
    const expiresAt = new Date(Date.parse(nowIso) + LEASE_MS).toISOString();

    const existing = await qe.list(ctx, "schedulerLease", {
      filters: [{ field: "name", op: "eq", value: LEASE_NAME }],
      pageSize: 1,
    });
    const row = existing.items[0];

    if (!row) {
      // First instance to start. A second one racing here loses on the unique
      // index rather than on a version — same outcome, different mechanism.
      try {
        await qe.create(ctx, "schedulerLease", {
          name: LEASE_NAME,
          holder: INSTANCE_ID,
          acquiredAt: nowIso,
          expiresAt,
          hostname: hostname(),
        });
        logger.info("scheduler lease acquired", { holder: INSTANCE_ID });
        return true;
      } catch {
        return false;
      }
    }

    const mine = String(row.holder) === INSTANCE_ID;
    const lapsed = String(row.expiresAt ?? "") <= nowIso;
    if (!mine && !lapsed) return false;

    await qe.update(
      ctx,
      "schedulerLease",
      String(row.id),
      { holder: INSTANCE_ID, acquiredAt: mine ? row.acquiredAt : nowIso, expiresAt, hostname: hostname() },
      // The version read above IS the election. If another instance claimed the
      // lease between that read and this write, the update conflicts — which is
      // the correct answer to "did I win?", not an error to recover from.
      { expectedVersion: Number(row.version) },
    );
    if (!mine) logger.info("scheduler lease taken over", { holder: INSTANCE_ID, previous: String(row.holder) });
    return true;
  } catch {
    // Includes the conflict from losing the race, which is not an error — it is
    // the answer.
    return false;
  }
}

/**
 * Give up the lease on shutdown.
 *
 * Not required for correctness — the lease would expire anyway — but it hands
 * over in seconds instead of minutes, which matters on a rolling deploy where
 * every instance restarts in turn.
 */
export async function releaseLease(): Promise<void> {
  try {
    const qe = await getQueryEngine();
    const ctx = sys();
    const existing = await qe.list(ctx, "schedulerLease", {
      filters: [{ field: "name", op: "eq", value: LEASE_NAME }],
      pageSize: 1,
    });
    const row = existing.items[0];
    if (!row || String(row.holder) !== INSTANCE_ID) return;
    // Expired in the past rather than deleted: the row is also the record of who
    // ran last, which is the first thing anyone asks when a job did not fire.
    await qe.patchComputed(ctx, "schedulerLease", String(row.id), { expiresAt: new Date(0).toISOString() });
    logger.info("scheduler lease released", { holder: INSTANCE_ID });
  } catch {
    /* shutting down; the lease expires on its own */
  }
}

/**
 * Who holds it — surfaced on the metrics endpoint.
 *
 * Takes the current time rather than reading the clock, matching the rest of the
 * codebase: every request carries `ctx.at` and every decision is made against
 * it. Reading `Date.now()` inside would also make this untestable against a
 * fixed clock, which is how the expiry check below went unverified.
 */
export async function leaseState(nowIso = new Date().toISOString()): Promise<LeaseState> {
  try {
    const qe = await getQueryEngine();
    const existing = await qe.list(sys(), "schedulerLease", {
      filters: [{ field: "name", op: "eq", value: LEASE_NAME }],
      pageSize: 1,
    });
    const row = existing.items[0];
    if (!row) return { held: false, holder: null, expiresAt: null };
    const expiresAt = String(row.expiresAt ?? "");
    return {
      // "Held" means holder is me AND the claim is still live. Reporting it from
      // the holder alone would make an instance whose lease has lapsed describe
      // itself as the leader — precisely the wrong answer to the question this
      // is read to answer, which is "was anyone actually running the jobs?".
      held: String(row.holder) === INSTANCE_ID && expiresAt > nowIso,
      holder: String(row.holder),
      expiresAt,
    };
  } catch {
    return { held: false, holder: null, expiresAt: null };
  }
}

export function instanceId(): string {
  return INSTANCE_ID;
}
