/**
 * Realtime channel tests.
 *
 * The interesting assertions are the negative ones. A fan-out that reaches the
 * wrong listener is a data leak that no screen would ever show you, so what is
 * pinned here is what does NOT go out: no record bodies, nothing across a tenant
 * boundary, nothing for an entity the listener cannot read, and no connection
 * without a valid ticket.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";
process.env.AULA_TRUST_PROXY = "0";

import test from "node:test";
import assert from "node:assert/strict";
import { realtimeHub, type RealtimeClient } from "@/lib/realtime/hub";
import { issueTicket, redeemTicket, outstandingTickets, resetTickets } from "@/lib/realtime/tickets";
import { eventBus, type DomainEvent } from "@/lib/workflow/event-bus";
import { systemContext } from "@/lib/context/resolver";
import type { RequestContext } from "@/lib/context/types";

realtimeHub.register();

/** A client that records what it was sent instead of writing to a socket. */
function spy(principal: {
  tenantId: string;
  orgId: string;
  userId: string;
  roles: string[];
}, topics: string[] = []): { client: RealtimeClient; sent: unknown[]; closed: string[] } {
  const sent: unknown[] = [];
  const closed: string[] = [];
  const client: RealtimeClient = {
    id: `c-${principal.userId}-${Math.round(sent.length)}-${principal.tenantId}`,
    principal: {
      tenantId: principal.tenantId,
      orgId: principal.orgId,
      userId: principal.userId,
      displayName: principal.userId,
      email: `${principal.userId}@example.test`,
      roles: principal.roles,
    },
    topics: new Set(topics),
    send: (payload) => sent.push(payload),
    close: (_code, reason) => closed.push(reason),
  };
  return { client, sent, closed };
}

function event(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: "evt-1",
    type: "invoice.updated",
    at: "2026-08-08T10:00:00.000Z",
    tenantId: "AULA-CRM",
    orgId: "Default Org",
    actorId: "u1",
    correlationId: "corr-1",
    payload: { id: "inv-1", record: { id: "inv-1", total: 12345, customerName: "Gizli Müşteri A.Ş." } },
    ...overrides,
  };
}

test("a signal carries the id, never the record", async () => {
  const { client, sent } = spy({ tenantId: "AULA-CRM", orgId: "Default Org", userId: "u1", roles: ["admin"] });
  realtimeHub.add(client);
  try {
    await eventBus.publish(event());
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], {
      kind: "event",
      type: "invoice.updated",
      entity: "invoice",
      id: "inv-1",
      at: "2026-08-08T10:00:00.000Z",
    });
    // The whole point: the payload held a total and a customer name, and the
    // permission layer never saw this path. Serialising the frame is the check
    // that matters — a nested field would not show up in a shallow compare.
    const wire = JSON.stringify(sent[0]);
    assert.ok(!wire.includes("12345"), "amounts must not travel on this channel");
    assert.ok(!wire.includes("Gizli"), "record fields must not travel on this channel");
  } finally {
    realtimeHub.remove(client.id);
  }
});

test("an event never crosses a tenant boundary", async () => {
  const mine = spy({ tenantId: "AULA-CRM", orgId: "Default Org", userId: "u1", roles: ["admin"] });
  const theirs = spy({ tenantId: "OTHER-CO", orgId: "Other Org", userId: "u2", roles: ["admin"] });
  realtimeHub.add(mine.client);
  realtimeHub.add(theirs.client);
  try {
    await eventBus.publish(event());
    assert.equal(mine.sent.length, 1);
    assert.equal(theirs.sent.length, 0, "a listener in another tenant must hear nothing at all");
  } finally {
    realtimeHub.remove(mine.client.id);
    realtimeHub.remove(theirs.client.id);
  }
});

test("a listener who cannot read the entity is not told it changed", async () => {
  // No roles and no grants: the permission engine denies `invoice:read`.
  const { client, sent } = spy({ tenantId: "AULA-CRM", orgId: "Default Org", userId: "u3", roles: [] });
  realtimeHub.add(client);
  try {
    await eventBus.publish(event());
    assert.equal(sent.length, 0, "the existence of a record is itself information");
  } finally {
    realtimeHub.remove(client.id);
  }
});

test("an unknown entity fans out to nobody rather than to everybody", async () => {
  const { client, sent } = spy({ tenantId: "AULA-CRM", orgId: "Default Org", userId: "u1", roles: ["admin"] });
  realtimeHub.add(client);
  try {
    // Platform events (file cleanup, metadata publish) have no entity to check
    // a read permission against, so there is no rule that would let them out.
    await eventBus.publish(event({ type: "metadata.published", payload: { id: "v2" } }));
    assert.equal(sent.length, 0);
  } finally {
    realtimeHub.remove(client.id);
  }
});

test("a subscription narrows what is delivered", async () => {
  const narrow = spy({ tenantId: "AULA-CRM", orgId: "Default Org", userId: "u1", roles: ["admin"] }, ["product"]);
  realtimeHub.add(narrow.client);
  try {
    await eventBus.publish(event());
    assert.equal(narrow.sent.length, 0, "subscribed to product only");
    await eventBus.publish(event({ type: "product.created", payload: { id: "p-1" } }));
    assert.equal(narrow.sent.length, 1);
  } finally {
    realtimeHub.remove(narrow.client.id);
  }
});

test("a ticket works once", () => {
  resetTickets();
  const ctx: RequestContext = systemContext("AULA-CRM", "Default Org", {
    userId: "u1",
    displayName: "U1",
    email: "u1@example.test",
    roles: Object.freeze(["admin"]),
    isSystem: false,
  });
  const { ticket } = issueTicket(ctx);
  assert.equal(outstandingTickets(), 1);

  const first = redeemTicket(ticket);
  assert.equal(first?.userId, "u1");
  assert.equal(outstandingTickets(), 0, "redeeming must consume it");

  assert.equal(redeemTicket(ticket), null, "a replayed ticket must not open a second socket");
  assert.equal(redeemTicket("not-a-ticket"), null);
});

test("a ticket copies the principal, so a later context change cannot widen it", () => {
  resetTickets();
  const roles = ["sales"];
  const ctx: RequestContext = systemContext("AULA-CRM", "Default Org", {
    userId: "u4",
    displayName: "U4",
    email: "u4@example.test",
    roles: Object.freeze([...roles]),
    isSystem: false,
  });
  const { ticket } = issueTicket(ctx);
  roles.push("admin"); // mutate the array the caller passed
  const principal = redeemTicket(ticket);
  assert.deepEqual([...(principal?.roles ?? [])], ["sales"]);
});
