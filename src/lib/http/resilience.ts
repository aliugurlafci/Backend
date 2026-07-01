/**
 * Resilience middleware — keeps the process healthy when many requests pile up
 * at once (the stress-test scenario). Two guards:
 *
 *  1. Backpressure / load-shedding: cap the number of in-flight requests. Beyond
 *     the cap we return 503 immediately instead of accepting unbounded work that
 *     would exhaust the DB pool + event loop and eventually crash the process.
 *     Clients (incl. the mobile outbox) treat 503 as retryable, so shed work is
 *     retried, not lost.
 *  2. Request timeout: if a handler hasn't responded within the budget, reply
 *     503 so clients aren't left hanging on a stuck request (e.g. a slow query
 *     holding a pool connection). The in-flight slot frees on response end.
 *
 * The in-flight gauge is also read by graceful shutdown to drain before exit.
 */
import type { Request, Response, NextFunction } from "express";
import { metrics } from "@/lib/observability/metrics";
import { setApiHeaders } from "@/lib/http/handler";

const MAX_INFLIGHT = Math.max(1, Number(process.env.AULA_MAX_INFLIGHT ?? 256));
const REQUEST_TIMEOUT_MS = Math.max(1_000, Number(process.env.AULA_REQUEST_TIMEOUT_MS ?? 30_000));

let inflight = 0;

/** Current in-flight request count (used by the health check + shutdown drain). */
export function getInflight(): number {
  return inflight;
}

export function resilience() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (inflight >= MAX_INFLIGHT) {
      metrics.increment("api.shed");
      setApiHeaders(res);
      res.setHeader("retry-after", "1");
      res.status(503).json({ error: { code: "OVERLOADED", message: "server busy, retry shortly" } });
      return;
    }

    inflight++;
    let settled = false;
    const release = (): void => {
      if (settled) return;
      settled = true;
      inflight--;
      clearTimeout(timer);
    };

    const timer = setTimeout(() => {
      if (!res.headersSent) {
        metrics.increment("api.timeout");
        setApiHeaders(res);
        res.status(503).json({ error: { code: "TIMEOUT", message: "request timed out" } });
      }
      // The underlying handler may still finish; its slot frees on 'finish'/'close'.
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();

    res.on("finish", release);
    res.on("close", release);
    next();
  };
}
