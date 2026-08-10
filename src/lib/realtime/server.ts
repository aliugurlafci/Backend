/**
 * WebSocket transport for the realtime channel.
 *
 * Mounted on the existing HTTP server at `/ws`, so there is one port, one TLS
 * termination and one set of firewall rules.
 *
 * Authentication happens during the HTTP upgrade, BEFORE the socket is accepted.
 * A rejected upgrade is a plain HTTP 401 the client can read; accepting first
 * and closing later hides the reason behind a close code and leaves a window
 * where an unauthenticated socket exists.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { logger } from "@/lib/observability/logger";
import { metrics } from "@/lib/observability/metrics";
import { realtimeHub } from "./hub";
import { redeemTicket, type TicketPrincipal } from "./tickets";

export const REALTIME_PATH = "/ws";

/**
 * Liveness probe interval.
 *
 * A TCP connection through a NAT or load balancer can die without either end
 * being told, leaving a socket that looks open and receives nothing. The ping
 * both detects that and keeps idle intermediaries from timing the connection
 * out — most give up around 60s, so this stays comfortably under it.
 */
const HEARTBEAT_MS = 30_000;

/** Largest message accepted from a client. Subscriptions are tiny; nothing else is read. */
const MAX_PAYLOAD = 4 * 1024;

interface Live {
  socket: WebSocket;
  alive: boolean;
  clientId: string;
}

let wss: WebSocketServer | null = null;
let heartbeat: NodeJS.Timeout | null = null;
const live = new Set<Live>();

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/** Read `?ticket=` without trusting the Host header to build a URL. */
function ticketFrom(req: IncomingMessage): string | null {
  const qs = req.url?.indexOf("?") ?? -1;
  if (qs < 0) return null;
  return new URLSearchParams(req.url!.slice(qs + 1)).get("ticket");
}

function onConnection(socket: WebSocket, principal: TicketPrincipal): void {
  const clientId = randomUUID();
  const entry: Live = { socket, alive: true, clientId };
  live.add(entry);

  const topics = new Set<string>();
  realtimeHub.add({
    id: clientId,
    principal,
    topics,
    send: (payload) => socket.send(JSON.stringify(payload)),
    close: (code, reason) => socket.close(code, reason),
  });
  metrics.increment("realtime.connections");

  socket.send(JSON.stringify({ kind: "ready", clientId }));

  socket.on("pong", () => {
    entry.alive = true;
  });

  socket.on("message", (raw) => {
    // The only thing a client may say is which entities it cares about.
    // Everything else is ignored rather than answered — this socket is an
    // outbound notification channel, not a second API surface, and treating it
    // as one would mean re-implementing authorisation here.
    try {
      const msg = JSON.parse(String(raw)) as { action?: string; entities?: unknown };
      if (msg.action === "subscribe" && Array.isArray(msg.entities)) {
        topics.clear();
        for (const e of msg.entities.slice(0, 100)) {
          if (typeof e === "string") topics.add(e);
        }
        socket.send(JSON.stringify({ kind: "subscribed", entities: [...topics] }));
      }
    } catch {
      // Malformed frame: ignore. Disconnecting would let one bad client message
      // take out a session that is otherwise working.
    }
  });

  const cleanup = (): void => {
    live.delete(entry);
    realtimeHub.remove(clientId);
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}

/** Attach the realtime channel to a running HTTP server. */
export function attachRealtime(server: Server): void {
  if (wss) return;
  realtimeHub.register();
  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== REALTIME_PATH) {
      // Not ours. Destroy rather than ignore: leaving the socket open holds a
      // file descriptor for a connection nobody will ever answer.
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const ticket = ticketFrom(req);
    const principal = ticket ? redeemTicket(ticket) : null;
    if (!principal) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    wss!.handleUpgrade(req, socket, head, (ws) => onConnection(ws, principal));
  });

  heartbeat = setInterval(() => {
    for (const entry of live) {
      if (!entry.alive) {
        // Missed the previous round trip: the peer is gone even though the
        // socket still reports open. `terminate` skips the close handshake,
        // which a dead peer would never complete.
        entry.socket.terminate();
        continue;
      }
      entry.alive = false;
      entry.socket.ping();
    }
  }, HEARTBEAT_MS);
  // Never hold the process open for a heartbeat.
  heartbeat.unref();

  logger.info("realtime channel attached", { path: REALTIME_PATH, heartbeatMs: HEARTBEAT_MS });
}

/** Close every socket and stop the heartbeat (graceful shutdown). */
export async function closeRealtime(): Promise<void> {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  realtimeHub.closeAll();
  for (const entry of live) entry.socket.terminate();
  live.clear();
  await new Promise<void>((resolve) => {
    if (!wss) return resolve();
    wss.close(() => resolve());
  });
  wss = null;
}

/** Live socket count — surfaced on the metrics endpoint. */
export function realtimeConnectionCount(): number {
  return live.size;
}
