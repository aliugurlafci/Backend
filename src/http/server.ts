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

import { corsOrigins } from "@/lib/config/env";
import { CSRF_COOKIE, issueCsrfToken } from "@/lib/security/csrf";
import { toAppError } from "@/lib/enforcement/errors";
import { API_VERSION, setApiHeaders } from "@/lib/http/handler";
import { resilience } from "@/lib/http/resilience";
import { buildApiRouter } from "./api";

export function createApp(): express.Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", true);

  app.use(
    helmet({
      frameguard: { action: "deny" },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      crossOriginResourcePolicy: { policy: "cross-origin" },
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
