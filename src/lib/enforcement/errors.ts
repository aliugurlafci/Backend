/**
 * Phase 3 — Structured error model.
 *
 * Every failure surfaced to an enforcement boundary (API, domain, query) is an
 * `AppError` with a stable machine-readable `code`, an HTTP status, and optional
 * structured `details`. This gives clients a consistent error contract and lets
 * the API layer serialize any thrown error deterministically.
 */

export type ErrorCode =
  | "VALIDATION"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "TENANT_ISOLATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "BAD_REQUEST"
  | "INTERNAL";

export interface ErrorDetail {
  field?: string;
  message: string;
}

export interface SerializedError {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
    correlationId?: string;
  };
}

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly httpStatus: number,
    message: string,
    public readonly details?: ErrorDetail[],
    /** When false, the message is safe to expose to clients verbatim. */
    public readonly expose: boolean = true,
  ) {
    super(message);
    this.name = new.target.name;
  }

  serialize(correlationId?: string): SerializedError {
    return {
      error: {
        code: this.code,
        message: this.expose ? this.message : "An unexpected error occurred",
        ...(this.details ? { details: this.details } : {}),
        ...(correlationId ? { correlationId } : {}),
      },
    };
  }
}

export class ValidationError extends AppError {
  constructor(details: ErrorDetail[], message = "Validation failed") {
    super("VALIDATION", 422, message, details);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "Authentication required") {
    super("UNAUTHENTICATED", 401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action", details?: ErrorDetail[]) {
    super("FORBIDDEN", 403, message, details);
  }
}

/** Raised when a record from another tenant/org is touched — never exposes why. */
export class TenantIsolationError extends AppError {
  constructor() {
    super("TENANT_ISOLATION", 404, "Resource not found", undefined, true);
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    super("NOT_FOUND", 404, id ? `${entity} "${id}" not found` : `${entity} not found`);
  }
}

/** Optimistic-concurrency / lifecycle conflict (Phase 5 & 7). */
export class ConflictError extends AppError {
  constructor(message: string, details?: ErrorDetail[]) {
    super("CONFLICT", 409, message, details);
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds: number) {
    super("RATE_LIMITED", 429, `Rate limit exceeded. Retry after ${retryAfterSeconds}s`);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string) {
    super("BAD_REQUEST", 400, message);
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError("INTERNAL", 500, message, undefined, false);
}
