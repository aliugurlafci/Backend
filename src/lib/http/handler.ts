/**
 * API plumbing (Express).
 *
 * `runApi(handler, opts)` wraps every route with: context resolution (auth +
 * locale + flags), per-principal rate limiting, CSRF on mutations, structured
 * error serialization, API-version headers and request metrics. Handlers just
 * return data; transport concerns live here.
 */
import type { Request, Response } from "express";
import { localizeAppError } from "@/lib/i18n/errors";
import { resolveContext } from "@/lib/context/resolver";
import type { RequestContext } from "@/lib/context/types";
import { BadRequestError, ForbiddenError, NotFoundError, RateLimitError, toAppError } from "@/lib/enforcement/errors";
import { metadata } from "@/lib/metadata";
import { CSRF_COOKIE, CSRF_HEADER, verifyCsrf } from "@/lib/security/csrf";
import { rateLimit } from "@/lib/security/rate-limit";
import { assertTokenActive } from "@/lib/security/revocation";
import { logger } from "@/lib/observability/logger";
import { metrics } from "@/lib/observability/metrics";
import { MAX_PAGE_SIZE, type Filter, type FilterOperator, type Query, type Sort } from "@/lib/data/query";
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

/**
 * A request handled slower than this is logged at `warn` even when it succeeded.
 *
 * Slow successes are how a missing index or an N+1 first shows up, and they are
 * invisible in error logs by definition.
 */
const SLOW_REQUEST_MS = 1_000;

/** Wrap a handler into an Express middleware with the full enforcement pipeline. */
export function runApi(handler: ApiHandler, opts: ApiOptions = {}) {
  return async (req: Request, res: Response): Promise<void> => {
    let ctx: RequestContext | undefined;
    // Bound before the try so the catch can use it even if context resolution
    // is what failed; enriched with the principal once we have one.
    let log = logger.child({ method: req.method, path: req.path });
    const startedAt = Date.now();
    try {
      ctx = resolveContext(toHeaders(req));
      log = log.child({ correlationId: ctx.correlationId, userId: ctx.userId });
      metrics.increment("api.requests");

      // A valid SIGNATURE is not the same as a valid session. The token carries
      // the grants it was issued with and consults nothing, so without this a
      // revoked permission — or a stolen token — kept working until it expired.
      // It runs here rather than in the authenticator because that contract is
      // synchronous and this needs storage. Costs no query on the common path:
      // the denylist is in memory and epochs are cached for seconds.
      await assertTokenActive(ctx);

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
      const ms = Date.now() - startedAt;
      if (ms >= SLOW_REQUEST_MS) log.warn("slow request", { ms, status: opts.status ?? 200 });
      else log.debug("api request", { ms, status: opts.status ?? 200 });
      if (res.headersSent) return; // handler already wrote a custom response (e.g. CSV)
      sendJson(res, data, opts.status ?? 200, ctx.correlationId);
    } catch (error) {
      const appError = toAppError(error);
      const ms = Date.now() - startedAt;
      if (appError.httpStatus >= 500) {
        log.error("api error", { error: appError.message, status: appError.httpStatus, ms });
      } else {
        // Client errors used to be logged NOWHERE, so a permission wall, a
        // validation loop or a conflict storm left no trace at all — the only
        // evidence was a counter with no message attached. At debug they cost
        // nothing in production and are there when someone goes looking.
        log.debug("api client error", { error: appError.message, status: appError.httpStatus, ms });
      }
      metrics.increment("api.errors");
      if (res.headersSent) return;
      // Serialized in the REQUEST's language, not the code's. The backend
      // throws in English (logs above stay grep-able); what the person at the
      // till reads is decided here from ctx.locale — or from the headers when
      // context resolution itself is what failed.
      sendJson(
        res,
        localizeAppError(appError, ctx?.locale ?? req, ctx?.correlationId),
        appError.httpStatus,
        ctx?.correlationId,
      );
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
 * Operators a caller may name in the query string.
 *
 * The repository has supported all of these from the start; the HTTP layer only
 * ever built `eq`, so "invoices over 10,000" or "products whose name contains X"
 * were expressible in SQL, expressible in the filter type, and unreachable from
 * a URL. Screens worked around it by reading a page and filtering in the
 * browser, which is wrong as soon as the result spans more than one page.
 */
const QUERY_OPERATORS = new Set<FilterOperator>(["eq", "ne", "lt", "lte", "gt", "gte", "contains", "in"]);

function isQueryOperator(value: string): value is FilterOperator {
  return QUERY_OPERATORS.has(value as FilterOperator);
}

/**
 * Parse list query params:
 *   ?q=&page=&pageSize=&sort=field:dir&sort=field2:asc
 *   &filter.<field>=value            → eq
 *   &filter.<field>.<op>=value       → that operator
 *   &filter.<field>.in=a,b,c         → in (comma-separated)
 *
 * Re-parsed from the raw query string so behaviour matches the original spec
 * regardless of Express's query parser. When `entity` is supplied, filter values
 * are coerced to their declared field types.
 *
 * A trailing segment that is NOT a known operator is treated as part of the
 * field name, so `filter.some.field=x` keeps working rather than being silently
 * reinterpreted — and an unknown operator can never fall through as `eq`, which
 * would answer a question nobody asked with data that looks right.
 */
export function parseListQuery(req: Request, entity?: string): Query {
  const qIndex = req.originalUrl.indexOf("?");
  const sp = new URLSearchParams(qIndex >= 0 ? req.originalUrl.slice(qIndex + 1) : "");

  const sort: Sort[] = sp.getAll("sort").flatMap<Sort>((s) => {
    const [field, dir] = s.split(":");
    // `?sort=` with no field used to become `{ field: "" }` and travel all the
    // way to the repository, which rejected it against the column whitelist. An
    // empty sort is not a request to sort by nothing; it is no request at all.
    if (!field) return [];
    return { field, dir: dir === "desc" ? "desc" : "asc" };
  });

  const filters: Filter[] = [];
  for (const [key, raw] of sp.entries()) {
    if (!key.startsWith("filter.") || raw === "") continue;
    const spec = key.slice("filter.".length);

    const dot = spec.lastIndexOf(".");
    const suffix = dot > 0 ? spec.slice(dot + 1) : "";
    const hasOperator = dot > 0 && isQueryOperator(suffix);
    const field = hasOperator ? spec.slice(0, dot) : spec;
    const op: FilterOperator = hasOperator ? suffix : "eq";

    if (op === "in") {
      // Comma-separated, because a repeated key would collide with the loop
      // above and an empty member would silently widen the set to everything.
      const members = raw.split(",").map((v) => v.trim()).filter(Boolean);
      if (members.length === 0) continue;
      filters.push({ field, op, value: members.map((v) => coerceFilterValue(v, entity, field)) });
      continue;
    }

    filters.push({ field, op, value: coerceFilterValue(raw, entity, field) });
  }

  const query: Query = {};
  if (sp.get("q")) query.search = sp.get("q")!;
  if (sp.get("page")) query.page = Number(sp.get("page"));
  if (sp.get("pageSize")) {
    const requested = Number(sp.get("pageSize"));
    // Reject rather than clamp. Silently returning 200 rows to a caller that
    // asked for 500 is how dashboards, exports and aging reports ended up
    // showing confidently wrong totals — the client had no way to know its
    // request had been trimmed. A 400 is recoverable; a wrong number is not.
    if (Number.isFinite(requested) && requested > MAX_PAGE_SIZE) {
      throw new BadRequestError(
        `pageSize must be ${MAX_PAGE_SIZE} or less (requested ${Math.floor(requested)}); ` +
          `page through the results or use the export endpoint for the full set`,
      );
    }
    query.pageSize = requested;
  }
  if (sort.length) query.sort = sort;
  if (filters.length) query.filters = filters;
  return query;
}

/**
 * A path parameter from a matched route.
 *
 * Express types `req.params` as a plain string dictionary, so under
 * `noUncheckedIndexedAccess` every `req.params.id` reads as `string |
 * undefined`. Asserting non-null at each of the hundred-odd call sites would
 * have silenced the compiler while stating nothing true; this states the actual
 * invariant once — a route that matched `/x/:id` HAS an `id`, or it would not
 * have matched.
 *
 * The undefined case therefore means the name asked for is not one the route
 * declares: a typo, or a handler moved to a path with different parameters.
 * That is a programming error, and a 400 naming the parameter is a far better
 * outcome than `undefined` flowing into a query and returning "not found".
 */
export function pathParam(req: Request, name: string): string {
  // `string[]` is Express's type for a wildcard capture. No route here declares
  // one, so joining is unreachable rather than meaningful — but silently taking
  // `[0]` of it would be a guess, and this way the value is never truncated.
  const raw = req.params[name];
  const value = Array.isArray(raw) ? raw.join("/") : raw;
  if (value === undefined || value === "") {
    throw new BadRequestError(`missing path parameter "${name}"`).withKey("err.missingPathParam", { name });
  }
  return value;
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
