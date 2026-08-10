/**
 * Token revocation.
 *
 * A JWT carries the grants it was issued with, and nothing consults the database
 * on the way in — that is what makes it fast, and it is also why revoking a
 * permission used to do nothing. Take a role away and the person keeps it until
 * their token expires: up to `AULA_JWT_TTL` (an hour by default) of continued
 * access under authority that has been withdrawn. `POST /auth/logout` only
 * cleared the cookie, so a stolen bearer token stayed valid for its full life.
 *
 * Two mechanisms, because there are two different questions:
 *
 *   `user.tokenEpoch`  — "nothing this user holds is valid any more."
 *                        One counter, one write, kills every session at once.
 *                        Bumped on password change, position/permission change,
 *                        deactivation, and "sign out everywhere".
 *   `revokedToken`     — "this ONE session is over."
 *                        Signing out on a phone must not sign you out of the
 *                        till; a mechanism that could not express that would
 *                        teach people not to sign out at all.
 *
 * WHY THE CHECK IS NOT IN THE AUTHENTICATOR: `Authenticator` is synchronous by
 * contract — it turns headers into a principal and cannot await a database. So
 * the signature check stays there and the revocation check runs in `runApi`,
 * immediately after the context resolves and before any handler sees it.
 *
 * COST: this must not add a query per request. The denylist is small and bounded
 * (only explicit sign-outs, and rows are pruned once the token would have
 * expired anyway), so it is held in memory and loaded once at boot. Epochs are
 * cached per user for a few seconds, which bounds how long a revocation can take
 * to bite — stated here rather than left to be discovered.
 */
import { getQueryEngine } from "@/lib/data/store";
import { systemContext } from "@/lib/context/resolver";
import type { RequestContext } from "@/lib/context/types";
import { UnauthenticatedError } from "@/lib/enforcement/errors";
import { logger } from "@/lib/observability/logger";
import { cache } from "@/lib/cache/cache";
import { TENANT_ID, ORG_ID } from "@/lib/config/env";
import { systemClock } from "@/lib/core/clock";

/**
 * How long a user's epoch is trusted before it is re-read.
 *
 * The window during which a revoked session can still make requests. Ten seconds
 * is short enough that "I removed their access" is true almost immediately, and
 * long enough that a busy screen does not turn one page load into a dozen
 * lookups. A denied user is stopped at the next check regardless — this only
 * bounds how long "next" is.
 */
const EPOCH_TTL_MS = 10_000;

/** In-memory denylist of `jti`s, mirroring the unexpired rows in the table. */
const revoked = new Set<string>();
let loaded = false;

function sys(): RequestContext {
  return systemContext(TENANT_ID, ORG_ID);
}

/**
 * Load the denylist from storage.
 *
 * Called at boot. Without it a restart would resurrect every revoked token —
 * an in-memory-only denylist is not a denylist, it is a delay.
 */
export async function loadRevocations(): Promise<void> {
  const qe = await getQueryEngine();
  const now = systemClock.isoNow();
  const rows = await qe.listComplete(sys(), "revokedToken", {
    // Anything already past its own expiry is refused by the token's `exp`
    // anyway, so it is not worth holding.
    filters: [{ field: "expiresAt", op: "gt", value: now }],
  });
  revoked.clear();
  for (const row of rows) revoked.add(String(row.jti));
  loaded = true;
  logger.info("token denylist loaded", { entries: revoked.size });
}

/**
 * Claim a token for rotation, synchronously, before anything is awaited.
 *
 * Refresh rotates: it mints a new token and revokes the one that asked. But the
 * revocation only happens after the user is read and the new token is signed,
 * and `runApi`'s revocation check ran before any of that — so several requests
 * carrying the SAME token all passed the check, all minted, and all revoked the
 * same already-revoked jti. A phone foregrounding fires half a dozen requests at
 * once; measured against a live server, six concurrent refreshes of one token
 * produced four valid sessions where there should have been one.
 *
 * The fix has to be synchronous, because the whole problem is the gap created by
 * the first `await`. This marks the jti revoked in the same tick as the check,
 * so the first caller wins and every other one is refused. Whoever wins persists
 * the row afterwards; the losers were carrying a token that is genuinely gone by
 * the time they are answered.
 *
 * Single-process, like the rest of this denylist — see the note at the top of
 * the file about why it is held in memory. The mobile client also collapses
 * concurrent renewals into one, so this is the second line of defence rather
 * than the only one.
 *
 * @returns true if this caller may proceed with the rotation.
 */
export function claimTokenForRotation(jti: string): boolean {
  if (!jti) return false;
  if (revoked.has(jti)) return false;
  revoked.add(jti);
  return true;
}

/** Withdraw one token (sign out on this device). */
export async function revokeToken(
  ctx: RequestContext,
  jti: string,
  expiresAtIso: string,
  reason = "logout",
): Promise<void> {
  if (!jti) return;
  revoked.add(jti);
  const qe = await getQueryEngine();
  try {
    await qe.create(sys(), "revokedToken", {
      jti,
      userId: ctx.userId,
      revokedAt: ctx.at,
      expiresAt: expiresAtIso,
      reason,
    });
  } catch (error) {
    // The in-memory entry already took effect, so the session IS over for this
    // process. Losing the row only means a restart would resurrect it, which is
    // worth a loud log rather than failing the sign-out the user asked for.
    logger.error("failed to persist token revocation", {
      jti,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Invalidate every token a user holds.
 *
 * Returns the new epoch. Callers that hold the user record should write it
 * themselves; this reads-modifies-writes so the caller does not have to.
 */
export async function bumpTokenEpoch(userId: string, reason: string): Promise<number> {
  const qe = await getQueryEngine();
  const ctx = sys();
  const user = await qe.get(ctx, "user", userId);
  const next = Number(user.tokenEpoch ?? 0) + 1;
  await qe.patchComputed(ctx, "user", userId, { tokenEpoch: next });
  await cache.delete(epochKey(userId));
  logger.info("token epoch bumped", { userId, epoch: next, reason });
  return next;
}

function epochKey(userId: string): string {
  return `auth:epoch:${userId}`;
}

/** The user's current epoch, cached briefly. */
async function currentEpoch(userId: string): Promise<number> {
  return cache.wrap(epochKey(userId), EPOCH_TTL_MS, async () => {
    const qe = await getQueryEngine();
    try {
      const user = await qe.get(sys(), "user", userId);
      // A deactivated account is treated as fully revoked. Otherwise disabling
      // someone left their current session running until it expired, which is
      // the opposite of what pressing "deactivate" is understood to mean.
      if (user.active === false) return Number.POSITIVE_INFINITY;
      return Number(user.tokenEpoch ?? 0);
    } catch {
      // The user is gone. Nothing they hold should still work.
      return Number.POSITIVE_INFINITY;
    }
  });
}

/**
 * Refuse a request made with a withdrawn token.
 *
 * Called from `runApi` for every authenticated request. System contexts (jobs,
 * migrations, seeds) carry no token and are not subject to this.
 */
export async function assertTokenActive(ctx: RequestContext): Promise<void> {
  if (ctx.isSystem) return;
  // A context with no token id predates this mechanism or came from a path that
  // does not issue one. Failing closed here would lock everyone out on deploy;
  // the epoch check below still applies, which is the part that matters for
  // revoked authority.
  if (ctx.jti && revoked.has(ctx.jti)) {
    throw new UnauthenticatedError("this session has been signed out");
  }
  if (ctx.tokenEpoch === undefined) return;
  const epoch = await currentEpoch(ctx.userId);
  if (ctx.tokenEpoch < epoch) {
    throw new UnauthenticatedError("your access changed; sign in again");
  }
}

/** Drop rows whose tokens have expired on their own. Called by the retention job. */
export async function pruneRevocations(ctx: RequestContext): Promise<number> {
  const qe = await getQueryEngine();
  const now = ctx.at;
  const stale = await qe.listComplete(ctx, "revokedToken", {
    filters: [{ field: "expiresAt", op: "lte", value: now }],
  });
  for (const row of stale) {
    await qe.remove(ctx, "revokedToken", String(row.id));
    revoked.delete(String(row.jti));
  }
  return stale.length;
}

/** Denylist size — for the metrics endpoint and tests. */
export function revocationCount(): number {
  return revoked.size;
}

export function isDenylistLoaded(): boolean {
  return loaded;
}

/** Test seam: clear in-process state without touching storage. */
export function resetRevocationsForTest(): void {
  revoked.clear();
  loaded = false;
}
