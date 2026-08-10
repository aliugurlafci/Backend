/**
 * End-to-end WebSocket tests.
 *
 * `realtime.test.ts` covers the fan-out rules against a fake client; this covers
 * the transport those rules sit behind — the upgrade handshake, where an
 * authentication mistake means an anonymous socket that then receives every
 * signal the hub emits.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";
process.env.AULA_TRUST_PROXY = "0";
process.env.AULA_EDGE_RATE_LIMIT = "5000";

import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { WebSocket } from "ws";

const { createApp } = await import("@/http/server");
const { attachRealtime, closeRealtime } = await import("@/lib/realtime/server");
const { issueTicket } = await import("@/lib/realtime/tickets");
const { systemContext } = await import("@/lib/context/resolver");
const { eventBus } = await import("@/lib/workflow/event-bus");

async function serve(): Promise<{ port: number; stop: () => Promise<void> }> {
  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  attachRealtime(server);
  const { port } = server.address() as AddressInfo;
  return {
    port,
    stop: async () => {
      await closeRealtime();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function adminTicket(): string {
  const ctx = systemContext("AULA-CRM", "Default Org", {
    userId: "u1",
    displayName: "U1",
    email: "u1@example.test",
    roles: Object.freeze(["admin"]),
    isSystem: false,
  });
  return issueTicket(ctx).ticket;
}

/** Resolve on the first message, or reject if the socket dies first. */
function firstMessage(ws: WebSocket, timeoutMs = 3_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a message")), timeoutMs);
    ws.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)));
    });
    ws.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

test("an upgrade without a ticket is refused with 401, not accepted then closed", async () => {
  const { port, stop } = await serve();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const status = await new Promise<number>((resolve, reject) => {
      // `ws` surfaces a rejected upgrade as `unexpected-response`, which carries
      // the real HTTP status — the reason a client can actually act on.
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => reject(new Error("socket opened without a ticket")));
      ws.on("error", () => {});
      setTimeout(() => reject(new Error("no response")), 3_000);
    });
    assert.equal(status, 401);
  } finally {
    await stop();
  }
});

test("an upgrade on another path is refused, not left hanging", async () => {
  const { port, stop } = await serve();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/not-ws?ticket=${adminTicket()}`);
    const status = await new Promise<number>((resolve, reject) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => reject(new Error("socket opened on an unrelated path")));
      ws.on("error", () => {});
      setTimeout(() => reject(new Error("no response")), 3_000);
    });
    assert.equal(status, 404);
  } finally {
    await stop();
  }
});

test("a redeemed ticket cannot open a second socket", async () => {
  const { port, stop } = await serve();
  try {
    const ticket = adminTicket();
    const first = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`);
    await new Promise<void>((resolve, reject) => {
      first.on("open", () => resolve());
      first.on("error", reject);
    });

    const second = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`);
    const status = await new Promise<number>((resolve, reject) => {
      second.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      second.on("open", () => reject(new Error("a replayed ticket opened a socket")));
      second.on("error", () => {});
      setTimeout(() => reject(new Error("no response")), 3_000);
    });
    assert.equal(status, 401);
    first.close();
  } finally {
    await stop();
  }
});

test("a valid ticket opens a socket that receives domain signals", async () => {
  const { port, stop } = await serve();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${adminTicket()}`);
    const ready = (await firstMessage(ws)) as { kind: string; clientId: string };
    assert.equal(ready.kind, "ready");
    assert.ok(ready.clientId);

    const incoming = firstMessage(ws);
    await eventBus.publish({
      id: "evt-ws-1",
      type: "product.created",
      at: "2026-08-08T10:00:00.000Z",
      tenantId: "AULA-CRM",
      orgId: "Default Org",
      actorId: "u1",
      correlationId: "corr-ws",
      payload: { id: "p-99", record: { id: "p-99", costPrice: 4242 } },
    });

    assert.deepEqual(await incoming, {
      kind: "event",
      type: "product.created",
      entity: "product",
      id: "p-99",
      at: "2026-08-08T10:00:00.000Z",
    });
    ws.close();
  } finally {
    await stop();
  }
});
