/**
 * Express application factory.
 *
 * Security headers (helmet), CORS, body + cookie parsing, a double-submit CSRF
 * cookie, the versioned API router, and JSON 404 / error fallbacks. The app is
 * transport-only; all business logic lives behind the router in the lib layers.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";

import { corsOrigins, trustProxy } from "@/lib/config/env";
import { CSRF_COOKIE, issueCsrfToken } from "@/lib/security/csrf";
import { toAppError } from "@/lib/enforcement/errors";
import { API_VERSION, setApiHeaders } from "@/lib/http/handler";
import { resilience } from "@/lib/http/resilience";
import { edgeRateLimit, logEdgeRateLimitPolicy } from "@/lib/security/edge-rate-limit";
import { buildApiRouter } from "./api";

export function createApp(): express.Express {
  const app = express();

  app.disable("x-powered-by");
  // Configured, not hardcoded to `true`. Trusting every hop makes `req.ip` the
  // leftmost X-Forwarded-For entry, and the client writes that header — which
  // silently turns every IP-based control (the login throttle, the edge limiter
  // below) into a counter the caller can reset at will. See AULA_TRUST_PROXY.
  app.set("trust proxy", trustProxy);

  app.use(
    helmet({
      frameguard: { action: "deny" },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      crossOriginResourcePolicy: { policy: "cross-origin" },
      /**
       * An API policy, not a web-app one.
       *
       * Helmet's default is written for a page that serves its own HTML: it
       * permits `script-src 'self'`, inline styles, images and fonts, and
       * `frame-ancestors 'self'` — which quietly contradicts the `DENY` above.
       * This service returns JSON and file bytes and never a document that needs
       * to load anything, so `'none'` is both correct and the strongest setting
       * available.
       *
       * It matters most for the one thing here that IS attacker-influenced:
       * uploaded files. Their content type is already checked against a
       * blocklist and anything not known-safe is forced to download as an
       * attachment — but if something ever renders in a browsing context anyway,
       * `default-src 'none'` means it can load nothing, call nowhere, and run no
       * inline script (script-src falls back to default-src). Defence in depth
       * behind a control that already exists, which is where it belongs.
       */
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          "default-src": ["'none'"],
          // Repeated explicitly rather than left to default-src: these three do
          // not fall back to it, so omitting them leaves them unrestricted.
          "frame-ancestors": ["'none'"],
          "base-uri": ["'none'"],
          "form-action": ["'none'"],
        },
      },
    }),
  );

  // Permissions-Policy (helmet does not set this one).
  app.use((_req, res, next) => {
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
    next();
  });

  app.use(
    cors({
      origin: corsOrigins === "*" ? true : corsOrigins,
      credentials: true,
      allowedHeaders: [
        "content-type",
        "authorization",
        "if-match",
        "x-locale",
        "x-correlation-id",
        "x-csrf-token",
      ],
      exposedHeaders: ["x-api-version", "x-correlation-id"],
    }),
  );

  // Load-shedding + request-timeout guard. Placed before body parsing so shed
  // requests don't even pay the JSON-parse cost, but after CORS so the browser
  // can still read the 503.
  app.use(resilience());

  // Edge cap per client IP. Ahead of body parsing and of the router, so an
  // unauthenticated flood is rejected on the way in — `runApi`'s per-principal
  // limiter never saw those requests, because authentication throws first.
  app.use(edgeRateLimit());
  logEdgeRateLimitPolicy(trustProxy);

  /**
   * SAP PI/PO posts raw XML or JSON to the ERP inbound endpoint.
   *
   * Mounted BEFORE `express.json` and scoped to that one path, because the JSON
   * parser would consume a JSON-typed body and hand on a parsed object — and
   * this endpoint needs the bytes: the codec detects the encoding from the body
   * rather than trusting a content-type PI/PO sets from channel configuration,
   * and the message is stored verbatim because when the two systems disagree
   * about what was sent, a re-serialised copy is not evidence.
   *
   * `type: () => true` accepts whatever content-type arrives, for the same
   * reason.
   */
  app.use("/api/v1/erp/inbound", express.text({ type: () => true, limit: "10mb" }));

  // 25mb so spreadsheet imports (a base64 .xlsx in the JSON body) aren't rejected.
  app.use(express.json({ limit: "25mb" }));
  app.use(cookieParser());

  // Issue a CSRF token cookie (double-submit) if the client doesn't have one.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!req.cookies?.[CSRF_COOKIE]) {
      res.cookie(CSRF_COOKIE, issueCsrfToken(), {
        httpOnly: false, // must be readable by the browser to echo in a header
        sameSite: "lax",
        path: "/",
        maxAge: 24 * 60 * 60 * 1000,
      });
    }
    next();
  });

  app.use("/api/v1", buildApiRouter());

  // JSON 404 for unknown routes.
  app.use((req: Request, res: Response) => {
    setApiHeaders(res);
    res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` } });
  });

  // Structured error fallback (e.g. malformed JSON body).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const appError = toAppError(err);
    setApiHeaders(res);
    res.status(appError.httpStatus).json(appError.serialize());
  });

  app.locals.apiVersion = API_VERSION;
  return app;
}
