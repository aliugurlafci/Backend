/**
 * Edge rate limiting — the outermost cap, applied before anything else runs.
 *
 * There are two limiters in this codebase and they guard different things:
 *
 *   edge (here)   — per client IP, every route, enforced as Express middleware
 *   per-principal — per user AND per path, enforced inside `runApi`
 *
 * The second one cannot do the first one's job, and the gap was real: `runApi`
 * resolves the request context — i.e. authenticates — as its very first step,
 * and an unauthenticated request throws there. The rate-limit call sits on the
 * line AFTER that throw, so every request that failed to authenticate was never
 * counted and therefore never limited. Credential stuffing, a scraper, a client
 * stuck in a retry loop: all uncapped, on the exact endpoints where an attacker
 * has no account to be limited by.
 *
 * This middleware runs ahead of body parsing and ahead of the router, so those
 * requests are rejected on the way in rather than after a full request cycle.
 *
 * The per-principal limiter stays. An IP limit cannot express "this account is
 * hammering one endpoint", and in an office everyone shares one NAT address —
 * so the two are complementary, not redundant.
 */
import { rateLimit as expressRateLimit } from "express-rate-limit";
import type { Request, RequestHandler, Response } from "express";
import { EDGE_RATE_LIMIT } from "@/lib/config/env";
import { API_VERSION } from "@/lib/http/handler";
import { logger } from "@/lib/observability/logger";
import { metrics } from "@/lib/observability/metrics";

const WINDOW_MS = 60_000;

/**
 * Paths exempt from the edge cap.
 *
 * Only the liveness probe. An orchestrator polls it on a fixed schedule and has
 * no way to back off — rate-limiting it turns a traffic spike into a restart
 * loop, which is a self-inflicted outage. It reads no tenant data and is cheap.
 */
function isExempt(req: Request): boolean {
  return req.path === "/api/v1/health";
}

/** Respond in the same envelope every other error uses, so clients parse one shape. */
function reject(_req: Request, res: Response): void {
  metrics.increment("api.rate_limited");
  res.setHeader("x-api-version", API_VERSION);
  res.status(429).json({
    error: {
      code: "RATE_LIMITED",
      message: "too many requests from this address; slow down and retry",
    },
  });
}

export function edgeRateLimit(): RequestHandler {
  return expressRateLimit({
    windowMs: WINDOW_MS,
    limit: EDGE_RATE_LIMIT,
    // draft-7 emits a single `RateLimit` header; the legacy `X-RateLimit-*` trio
    // says the same thing twice and we have no client that reads it.
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: isExempt,
    handler: reject,
    // `req.ip` is only trustworthy because `trust proxy` is configured from
    // AULA_TRUST_PROXY rather than left at "trust everything" — see env.ts. This
    // validator checks exactly that, so leave it on: it is the one thing
    // standing between this limiter and being bypassable with a header.
    validate: { trustProxy: true, xForwardedForHeader: true },
  });
}

/** Announce the effective policy once at boot, so it is visible in the logs. */
export function logEdgeRateLimitPolicy(trustProxy: boolean | number | string[]): void {
  if (trustProxy === true) {
    logger.warn(
      "AULA_TRUST_PROXY trusts every hop — X-Forwarded-For becomes caller-controlled and IP-based limits (including the login throttle) can be bypassed; set it to the actual proxy hop count",
    );
  }
  logger.info("edge rate limit active", { limit: EDGE_RATE_LIMIT, windowMs: WINDOW_MS, trustProxy });
}
