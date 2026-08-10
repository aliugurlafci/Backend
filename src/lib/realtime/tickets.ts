/**
 * Single-use, short-lived tickets for opening a WebSocket.
 *
 * A browser cannot set an `Authorization` header on `new WebSocket(...)`, and
 * the session cookie is `sameSite: lax`, so it is NOT sent on a cross-site
 * upgrade — and the socket connects to the backend origin directly rather than
 * through the frontend's `/api/v1` rewrite. That leaves the query string as the
 * only channel the browser controls, so the value put there is built to survive
 * being logged by a proxy: it authorises one connection, for a few seconds, and
 * is destroyed the moment it is redeemed.
 *
 * Kept in memory deliberately. A ticket outliving the process that issued it
 * would be a durable bearer credential, which is the opposite of the intent —
 * and a restart simply makes the client ask for another one.
 */
import { randomBytes } from "node:crypto";
import type { RequestContext } from "@/lib/context/types";

/** Long enough to survive a slow page, short enough that a leaked URL is stale. */
const TTL_MS = 30_000;

/**
 * Cap on outstanding tickets.
 *
 * An authenticated caller could otherwise mint them in a loop and grow the map
 * without bound. The oldest are dropped first; a client whose ticket vanished
 * asks for another, which is a retry rather than a failure.
 */
const MAX_OUTSTANDING = 10_000;

export interface TicketPrincipal {
  tenantId: string;
  orgId: string;
  userId: string;
  displayName: string;
  email: string;
  roles: readonly string[];
  grants?: readonly string[];
  positionId?: string;
}

interface Entry {
  principal: TicketPrincipal;
  expiresAt: number;
}

const tickets = new Map<string, Entry>();

function sweep(now: number): void {
  for (const [key, entry] of tickets) {
    if (entry.expiresAt <= now) tickets.delete(key);
  }
}

export function issueTicket(ctx: RequestContext): { ticket: string; expiresInMs: number } {
  const now = Date.now();
  sweep(now);
  // Map iterates in insertion order, so the front is the oldest.
  while (tickets.size >= MAX_OUTSTANDING) {
    const oldest = tickets.keys().next();
    if (oldest.done) break;
    tickets.delete(oldest.value);
  }

  const ticket = randomBytes(32).toString("base64url");
  tickets.set(ticket, {
    expiresAt: now + TTL_MS,
    principal: {
      tenantId: ctx.tenantId,
      orgId: ctx.orgId,
      userId: ctx.userId,
      displayName: ctx.displayName,
      email: ctx.email,
      roles: [...ctx.roles],
      grants: ctx.grants ? [...ctx.grants] : undefined,
      positionId: ctx.positionId,
    },
  });
  return { ticket, expiresInMs: TTL_MS };
}

/**
 * Redeem a ticket, consuming it.
 *
 * Deleting before checking expiry is intentional: a replay of an expired ticket
 * should not leave the entry behind for a third attempt.
 */
export function redeemTicket(ticket: string): TicketPrincipal | null {
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket);
  if (entry.expiresAt <= Date.now()) return null;
  return entry.principal;
}

/** Outstanding ticket count — for the metrics endpoint and tests. */
export function outstandingTickets(): number {
  return tickets.size;
}

export function resetTickets(): void {
  tickets.clear();
}
