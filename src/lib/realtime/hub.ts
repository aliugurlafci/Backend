/**
 * Realtime event channel — the fan-out side.
 *
 * Subscribes to the domain event bus once and pushes a notice to every
 * connection entitled to hear it. This replaces polling: the notification bell
 * polls every 20s, the automation screen every 1.8s, and the register has no way
 * at all to learn that a cart was sent to it.
 *
 * THE ONE RULE: this channel carries SIGNALS, NOT RECORDS.
 *
 * A domain event's payload is the whole record — `{ id, record }` — and the
 * permission layer redacts fields per user, per entity, per record owner. Piping
 * that payload down a socket would hand every listener a copy that never passed
 * through any of it: a side door around the entire authorisation model, opened
 * by an implementation detail of the event bus. So what goes out is
 * `{ type, entity, id, at }` and the client refetches through the normal API,
 * where the existing checks apply. A client learns only that something it can
 * already read has changed — never what it changed to.
 *
 * The entity-level `read` check below is therefore defence in depth rather than
 * the containment: it stops a user learning that records exist in an entity they
 * cannot open at all, which is inference the signal alone would leak.
 */
import type { RequestContext } from "@/lib/context/types";
import { systemContext } from "@/lib/context/resolver";
import { eventBus, type DomainEvent } from "@/lib/workflow/event-bus";
import { permissionEngine } from "@/lib/permissions/engine";
import { metadata } from "@/lib/metadata";
import { logger } from "@/lib/observability/logger";
import type { TicketPrincipal } from "./tickets";

/** What a subscriber receives. Intentionally the smallest useful thing. */
export interface RealtimeSignal {
  /** The domain event type, e.g. `invoice.updated`. */
  type: string;
  /** Entity the change belongs to, derived from the type. */
  entity: string;
  /** Record id, so a client can invalidate one row instead of a whole list. */
  id: string | null;
  at: string;
}

/** A connected client, as far as the hub is concerned. */
export interface RealtimeClient {
  id: string;
  principal: TicketPrincipal;
  /** Entities this client asked about; empty means "everything I may read". */
  topics: Set<string>;
  send(payload: unknown): void;
  close(code: number, reason: string): void;
}

/**
 * Per-user connection cap.
 *
 * One user legitimately has a few tabs open. A client stuck in a reconnect loop
 * opens one per second, and each holds a socket plus its permission context.
 */
export const MAX_CONNECTIONS_PER_USER = 8;

class RealtimeHub {
  private clients = new Map<string, RealtimeClient>();
  private subscribed = false;
  /** Permission contexts, rebuilt per connection rather than per event. */
  private contexts = new WeakMap<TicketPrincipal, RequestContext>();

  /** Attach to the event bus. Idempotent; safe to call from bootstrap. */
  register(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    eventBus.subscribe("*", (event: DomainEvent) => {
      this.broadcast(event);
    });
  }

  add(client: RealtimeClient): boolean {
    const forUser = [...this.clients.values()].filter(
      (c) => c.principal.userId === client.principal.userId && c.principal.tenantId === client.principal.tenantId,
    );
    if (forUser.length >= MAX_CONNECTIONS_PER_USER) {
      // Drop the oldest rather than refuse the newest: a reconnect loop means
      // the old sockets are the dead ones, and refusing would lock the user out
      // of realtime until they time out.
      forUser[0]?.close(1013, "too many connections for this user");
      this.clients.delete(forUser[0]?.id ?? "");
    }
    this.clients.set(client.id, client);
    return true;
  }

  remove(clientId: string): void {
    this.clients.delete(clientId);
  }

  size(): number {
    return this.clients.size;
  }

  /**
   * A permission context for a connection.
   *
   * Built from the ticket's claims — the same ones the JWT carries — so the
   * socket sees exactly the authority the HTTP session had when it connected.
   * It does NOT refresh: a role revoked mid-session still applies to this
   * socket until it reconnects, which is the same window the bearer token has.
   */
  private contextFor(principal: TicketPrincipal): RequestContext {
    const cached = this.contexts.get(principal);
    if (cached) return cached;
    const ctx = systemContext(principal.tenantId, principal.orgId, {
      userId: principal.userId,
      displayName: principal.displayName,
      email: principal.email,
      roles: Object.freeze([...principal.roles]),
      grants: principal.grants ? Object.freeze([...principal.grants]) : undefined,
      positionId: principal.positionId,
      // `systemContext` marks contexts as system, which bypasses every check.
      // That is right for jobs and migrations and catastrophically wrong here:
      // this context represents a logged-in person.
      isSystem: false,
    });
    this.contexts.set(principal, ctx);
    return ctx;
  }

  /** `invoice.updated` → `invoice`; `stage_changed` and lifecycle actions too. */
  private entityOf(type: string): string {
    const dot = type.indexOf(".");
    return dot > 0 ? type.slice(0, dot) : type;
  }

  private broadcast(event: DomainEvent): void {
    if (this.clients.size === 0) return;

    const entity = this.entityOf(event.type);
    const signal: RealtimeSignal = {
      type: event.type,
      entity,
      id: typeof event.payload?.id === "string" ? event.payload.id : null,
      at: event.at,
    };

    // An unknown entity is a platform event (file cleanup, metadata publish).
    // Those have no read permission to check, so they go nowhere rather than
    // everywhere — failing closed is the only safe default for a fan-out.
    const known = metadata.findEntity(entity);

    for (const client of this.clients.values()) {
      const p = client.principal;
      if (p.tenantId !== event.tenantId || p.orgId !== event.orgId) continue;
      if (client.topics.size > 0 && !client.topics.has(entity)) continue;
      if (!known) continue;
      if (!permissionEngine.can(this.contextFor(p), { action: `${entity}:read`, entity })) continue;

      try {
        client.send({ kind: "event", ...signal });
      } catch (error) {
        // A send failure is a dead socket, not a reason to abandon the rest of
        // the fan-out.
        logger.debug("realtime send failed", {
          clientId: client.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Close every connection — used on shutdown so sockets don't hold the process. */
  closeAll(): void {
    for (const client of this.clients.values()) client.close(1001, "server shutting down");
    this.clients.clear();
  }
}

export const realtimeHub = new RealtimeHub();
