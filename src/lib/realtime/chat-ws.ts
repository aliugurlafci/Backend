/**
 * Real-time chat over WebSocket.
 *
 * Attaches a `ws` server at `/ws/chat` to the existing HTTP server. The browser
 * connects directly (outside the Next BFF proxy) with `?actor=&tenant=` so the
 * backend can resolve the caller's context. Inbound `send` frames are persisted
 * through the domain service (RBAC + validation + audit + events apply) and then
 * broadcast to every socket in the same tenant/org, so all open clients update
 * live. History is still loaded over REST on page load.
 */
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { resolveContext } from "@/lib/context/resolver";
import type { RequestContext } from "@/lib/context/types";
import { getDomainService } from "@/lib/domain";
import { corsOrigins } from "@/lib/config/env";
import { logger } from "@/lib/observability/logger";

/** Mirror the HTTP CORS allow-list for the WebSocket handshake origin. */
function originAllowed(origin: string | undefined): boolean {
  if (corsOrigins === "*") return true;
  if (!origin) return true; // non-browser clients (no Origin header)
  return corsOrigins.includes(origin);
}

interface Client {
  socket: WebSocket;
  ctx: RequestContext;
}

const scopeKey = (ctx: RequestContext) => `${ctx.tenantId}:${ctx.orgId}`;

/** Build a Headers object the context resolver understands from the WS query. */
function headersFromQuery(url: URL): Headers {
  const h = new Headers();
  const actor = url.searchParams.get("actor");
  const tenant = url.searchParams.get("tenant");
  const token = url.searchParams.get("token");
  if (actor) h.set("x-actor", actor);
  if (tenant) h.set("x-tenant", tenant);
  if (token) h.set("authorization", `Bearer ${token}`);
  return h;
}

export function attachChatWs(server: Server): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: "/ws/chat",
    verifyClient: ({ origin }, done) => done(originAllowed(origin)),
  });
  const clients = new Set<Client>();

  function broadcast(scope: string, payload: unknown) {
    const data = JSON.stringify(payload);
    for (const c of clients) {
      if (scopeKey(c.ctx) === scope && c.socket.readyState === WebSocket.OPEN) c.socket.send(data);
    }
  }

  wss.on("connection", (socket, req) => {
    let ctx: RequestContext;
    try {
      const url = new URL(req.url ?? "/ws/chat", "http://localhost");
      ctx = resolveContext(headersFromQuery(url));
    } catch {
      socket.close(4401, "unauthenticated");
      return;
    }

    const client: Client = { socket, ctx };
    clients.add(client);
    socket.send(JSON.stringify({ type: "ready", user: ctx.displayName }));

    socket.on("message", async (raw) => {
      let msg: { type?: string; peer?: string; body?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type !== "send" || !msg.peer || !msg.body) return;
      try {
        const domain = await getDomainService();
        const record = await domain.create(ctx, "chatMessage", {
          peer: msg.peer,
          author: ctx.displayName,
          body: msg.body,
          fromMe: true,
        });
        broadcast(scopeKey(ctx), { type: "message", record });
      } catch (e) {
        socket.send(
          JSON.stringify({ type: "error", message: e instanceof Error ? e.message : "send failed" }),
        );
      }
    });

    socket.on("close", () => clients.delete(client));
    socket.on("error", () => clients.delete(client));
  });

  logger.info("chat websocket attached", { path: "/ws/chat" });
  return wss;
}
