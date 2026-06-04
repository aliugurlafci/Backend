/**
 * API plumbing (Express).
 *
 * `runApi(handler, opts)` wraps every route with: context resolution (auth +
 * locale + flags), per-principal rate limiting, CSRF on mutations, structured
 * error serialization, API-version headers and request metrics. Handlers just
 * return data; transport concerns live here.
 */
import type { Request, Response } from "express";
import { resolveContext } from "@/lib/context/resolver";
import type { RequestContext } from "@/lib/context/types";
import { ForbiddenError, NotFoundError, RateLimitError, toAppError } from "@/lib/enforcement/errors";
import { metadata } from "@/lib/metadata";
import { CSRF_COOKIE, CSRF_HEADER, verifyCsrf } from "@/lib/security/csrf";
import { rateLimit } from "@/lib/security/rate-limit";
import { logger } from "@/lib/observability/logger";
import { metrics } from "@/lib/observability/metrics";
import type { Filter, Query, Sort } from "@/lib/data/query";
import type { FieldValue } from "@/lib/metadata/types";

export const API_VERSION = "1";

export interface ApiOptions {
  mutating?: boolean;
  status?: number;
  rateLimit?: { limit: number; windowMs: number };
}

/** Request with route params narrowed to plain strings (no wildcard arrays). */
export type ApiRequest = Request<Record<string, string>>;

export type ApiHandler = (rc: RequestContext, req: ApiRequest, res: Response) => Promise<unknown>;

/** Build a Web `Headers` instance from Express request headers (for the resolver). */
export function toHeaders(req: Request): Headers {
  const h = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) h.set(key, value.join(", "));
    else if (typeof value === "string") h.set(key, value);
  }
  return h;
}

export function setApiHeaders(res: Response, correlationId?: string): void {
  res.setHeader("x-api-version", API_VERSION);
  if (correlationId) res.setHeader("x-correlation-id", correlationId);
}

function sendJson(res: Response, data: unknown, status: number, correlationId?: string): void {
  setApiHeaders(res, correlationId);
  res.status(status).json(data);
}

/** Wrap a handler into an Express middleware with the full enforcement pipeline. */
export function runApi(handler: ApiHandler, opts: ApiOptions = {}) {
  return async (req: Request, res: Response): Promise<void> => {
    let ctx: RequestContext | undefined;
    try {
      ctx = resolveContext(toHeaders(req));
      metrics.increment("api.requests");

      const rl = rateLimit(
        `${ctx.userId}:${req.path}`,
        opts.rateLimit?.limit ?? 240,
        opts.rateLimit?.windowMs ?? 60_000,
      );
      if (!rl.allowed) throw new RateLimitError(rl.retryAfter);

      if (opts.mutating) {
        // Double-submit CSRF: enforced only when the client set the cookie (browser).
        const cookie = (req.cookies?.[CSRF_COOKIE] as string | undefined) ?? null;
        if (cookie && !verifyCsrf(req.get(CSRF_HEADER) ?? null, cookie)) {
          throw new ForbiddenError("CSRF token mismatch");
        }
      }

      const data = await handler(ctx, req as ApiRequest, res);
      if (res.headersSent) return; // handler already wrote a custom response (e.g. CSV)
      sendJson(res, data, opts.status ?? 200, ctx.correlationId);
    } catch (error) {
      const appError = toAppError(error);
      if (appError.httpStatus >= 500) {
        logger.error("api error", { error: appError.message, correlationId: ctx?.correlationId });
      }
      metrics.increment("api.errors");
      if (res.headersSent) return;
      sendJson(res, appError.serialize(ctx?.correlationId), appError.httpStatus, ctx?.correlationId);
    }
  };
}

/**
 * Coerce a raw query-string filter value to the field's metadata type so it
 * compares correctly against typed storage (e.g. a `bit` column or the strict
 * `===` of the in-memory repository). Without the entity we fall back to a
 * numeric-looking heuristic for backwards compatibility.
 */
function coerceFilterValue(raw: string, entity?: string, field?: string): FieldValue {
  if (entity && field) {
    const fieldDef = metadata.findEntity(entity)?.fields.find((f) => f.name === field);
    switch (fieldDef?.type) {
      case "boolean":
        return raw === "true" || raw === "1";
      case "number":
      case "currency":
      case "percent":
        return Number(raw);
      case undefined:
        break; // unknown field — fall through to the heuristic
      default:
        return raw; // string-like field (enum, reference, email, …): keep verbatim
    }
  }
  return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
}

/**
 * Parse list query params:
 *   ?q=&page=&pageSize=&sort=field:dir&sort=field2:asc&filter.<field>=value
 * Re-parsed from the raw query string so behaviour matches the original spec
 * regardless of Express's query parser. When `entity` is supplied, filter values
 * are coerced to their declared field types.
 */
export function parseListQuery(req: Request, entity?: string): Query {
  const qIndex = req.originalUrl.indexOf("?");
  const sp = new URLSearchParams(qIndex >= 0 ? req.originalUrl.slice(qIndex + 1) : "");

  const sort: Sort[] = sp.getAll("sort").map((s) => {
    const [field, dir] = s.split(":");
    return { field, dir: dir === "desc" ? "desc" : "asc" };
  });

  const filters: Filter[] = [];
  for (const [key, raw] of sp.entries()) {
    if (!key.startsWith("filter.") || raw === "") continue;
    const field = key.slice("filter.".length);
    filters.push({ field, op: "eq", value: coerceFilterValue(raw, entity, field) });
  }

  const query: Query = {};
  if (sp.get("q")) query.search = sp.get("q")!;
  if (sp.get("page")) query.page = Number(sp.get("page"));
  if (sp.get("pageSize")) query.pageSize = Number(sp.get("pageSize"));
  if (sort.length) query.sort = sort;
  if (filters.length) query.filters = filters;
  return query;
}

/** Throw a 404 if the entity isn't in the active metadata. */
export function assertKnownEntity(entity: string): void {
  if (!metadata.findEntity(entity)) throw new NotFoundError("entity", entity);
}

/** Parse an `If-Match` header into an expected version for optimistic locking. */
export function parseIfMatch(req: Request): number | undefined {
  const header = req.get("if-match");
  if (!header) return undefined;
  const n = Number(header.replace(/"/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** The parsed JSON body (Express `express.json()` already parsed it). */
export function readJson(req: Request): unknown {
  return req.body ?? {};
}
