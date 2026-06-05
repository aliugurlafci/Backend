/**
 * Real-time chat over WebSocket.
 *
 * Attaches a `ws` server at `/ws/chat` to the existing HTTP server. The browser
 * connects directly (outside the Next BFF proxy) with `?actor=&tenant=` so the
 * backend can resolve the caller's context. Inbound `send` frames are persisted
 * through the chat service (server-side participant-membership check) and then
 * delivered ONLY to the conversation's participants in the same tenant/org, so a
 * DM is private. History is still loaded over REST on page load.
 */
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { resolveContext } from "@/lib/context/resolver";
import type { RequestContext } from "@/lib/context/types";
import type { EntityRecord } from "@/lib/metadata/types";
import { createMessage } from "@/lib/chat/service";
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

  /** Deliver a persisted message ONLY to its participants in the same tenant/org. */
  function deliver(record: EntityRecord) {
    const scope = `${record.tenantId}:${record.orgId}`;
    const participants = String(record.participants ?? "");
    const data = JSON.stringify({ type: "message", record });
    for (const c of clients) {
      if (
        scopeKey(c.ctx) === scope &&
        participants.includes(`,${c.ctx.userId},`) &&
        c.socket.readyState === WebSocket.OPEN
      ) {
        c.socket.send(data);
      }
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
      let msg: {
        type?: string;
        participants?: Array<string | number>;
        conversationId?: string;
        body?: string;
        attachments?: { fileId: string; name: string; kind: "image" | "file"; sizeKb?: number }[];
      };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type !== "send") return;
      try {
        const record = await createMessage(ctx, {
          participants: msg.participants,
          conversationId: msg.conversationId,
          body: msg.body,
          attachments: msg.attachments,
        });
        deliver(record);
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
