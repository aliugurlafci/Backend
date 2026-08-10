/**
 * Liveness, operational counters, the API's own contract document, and the
 * ticket that authorises a realtime socket.
 */

import { type Router } from "express";
import { type Request, type Response } from "express";
import { runApi, setApiHeaders } from "@/lib/http/handler";
import { buildOpenApiDocument } from "@/lib/openapi/generate";
import { metadata } from "@/lib/metadata";
import { metrics } from "@/lib/observability/metrics";
import { getInflight } from "@/lib/http/resilience";
import { issueTicket } from "@/lib/realtime/tickets";
import { REALTIME_PATH, realtimeConnectionCount } from "@/lib/realtime/server";
import { usingInMemoryBackends } from "@/lib/config/env";
import { pingDatabase } from "@/lib/data/sql/connection";
import { adminOnly } from "./shared";

export function registerSystemRoutes(r: Router): void {
  // ---- health (public, no auth) ----------------------------------------
  // Liveness/readiness. Public and deliberately thin: it reports whether this
  // instance can actually serve, and nothing an anonymous caller could mine.
  //
  // It used to answer `status: "ok"` without touching the database — so a dead
  // connection pool looked healthy to every load balancer in front of it — and
  // it published request/error/deadlock counters to anyone who asked. Those
  // counters now live behind `/metrics`.
  r.get("/health", async (_req: Request, res: Response) => {
    setApiHeaders(res);
    const database = usingInMemoryBackends ? "not-applicable" : await pingDatabase();
    const healthy = database !== "error";
    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "down",
      database,
      metadataVersion: metadata.version,
      backends: usingInMemoryBackends ? "in-memory" : "external",
    });
  });

  // Operational counters — admin only. Request/error/deadlock/shed rates and
  // in-flight depth describe how the system is behaving under load, which is
  // reconnaissance for anyone who is not running it.
  r.get("/metrics", runApi(async (rc) => {
    adminOnly(rc);
    const { leaseState } = await import("@/lib/jobs/lease");
    return {
      inflight: getInflight(),
      realtimeConnections: realtimeConnectionCount(),
      // Which instance is running the jobs. The first question when a scheduled
      // job did not fire is "was anyone the leader?", and it should not require
      // reading a table by hand.
      scheduler: await leaseState(rc.at),
      metrics: metrics.snapshot(),
    };
  }));

  // ---- contract ----------------------------------------------------------
  // The OpenAPI document, generated from entity metadata and the request
  // schemas the handlers validate with.
  //
  // Authenticated, because it enumerates every entity, field and endpoint —
  // a map of the whole system, which is exactly what an attacker would like
  // before choosing where to push. Any signed-in caller may read it: it
  // describes what the API accepts, not what this caller is permitted to do.
  //
  // Built per request rather than cached: it is read by a human or a code
  // generator a handful of times, and a cache would be one more thing that can
  // serve a stale contract after a metadata publish.
  r.get("/openapi.json", runApi(async () => buildOpenApiDocument()));

  // ---- realtime ---------------------------------------------------------
  // Mint a ticket for opening the WebSocket at /ws. A browser cannot set an
  // Authorization header on `new WebSocket(...)`, so the socket is authorised by
  // a value the client can put in the query string — one that is single-use and
  // expires in seconds, precisely because a query string is the thing most
  // likely to end up in a proxy log. Nothing else about the socket is derived
  // from the request: the ticket carries the principal.
  r.post(
    "/realtime/ticket",
    runApi(
      async (rc) => {
        const { ticket, expiresInMs } = issueTicket(rc);
        return { ticket, expiresInMs, path: REALTIME_PATH };
      },
      // Tighter than the default: a client needs one ticket per connection, and
      // a reconnect loop asking for hundreds is the case worth capping.
      { mutating: true, rateLimit: { limit: 30, windowMs: 60_000 } },
    ),
  );
}
